import { combineLatest, defer, from, Observable } from "rxjs"
import { map, mergeMap, startWith } from "rxjs/operators"
import { AbstractConnectionProvider } from "../provider"
import { Maybe } from "../../common/maybe"
import { EthereumWallet } from "./domain"
import { promiseToObservable } from "../common/utils"
import { ConnectionState, STATE_DISCONNECTED, getStateConnecting, getStateConnected } from "../connection-state"

export enum DappType {
	Metamask = "Metamask",
	Trust = "Trust",
	GoWallet = "GoWallet",
	AlphaWallet = "AlphaWallet",
	Status = "Status",
	Coinbase = "Coinbase",
	Cipher = "Cipher",
	Mist = "Mist",
	Parity = "Parity",
	ImToken = "ImToken",
	Dapper = "Dapper",
	Mock = "Mock",
	Generic = "Web3",
}

const PROVIDER_ID = "injected" as const

export class InjectedWeb3ConnectionProvider extends AbstractConnectionProvider<DappType, EthereumWallet> {
	private readonly connection: Observable<ConnectionState<EthereumWallet>>

	constructor() {
		super()
		this.connection = defer(() => from(connect())).pipe(
			mergeMap(() => promiseToObservable(getWalletAsync())),
			map((wallet) => {
				if (wallet) {
					const disconnect = () => {
						if ("close" in wallet.provider) {
							return wallet.provider.close()
						}
						if ("disconnect" in wallet.provider) {
							return wallet.provider.disconnect()
						}
						return Promise.resolve()
					}
					return getStateConnected({ connection: wallet, disconnect })
				} else {
					return STATE_DISCONNECTED
				}
			}),
			startWith(getStateConnecting({ providerId: PROVIDER_ID })),
		)
	}

	getId(): string {
		return PROVIDER_ID
	}

	getConnection(): Observable<ConnectionState<EthereumWallet>> {
		return this.connection
	}

	getOption(): Promise<Maybe<DappType>> {
		const provider = getInjectedProvider()
		return Promise.resolve(getDappType(provider))
	}

	isAutoConnected(): Promise<boolean> {
		const provider = getInjectedProvider()
		const dapp = getDappType(provider)
		return Promise.resolve(isDappSupportAutoconnect(dapp))
	}

	async isConnected(): Promise<boolean> {
		const provider = getInjectedProvider()
		if (provider !== undefined) {
			return getAccounts(provider)
				.then(([account]) => account !== undefined)
		} else {
			return Promise.resolve(false)
		}
	}
}

async function connect(): Promise<void> {
	const provider = getInjectedProvider()
	if (!provider) {
		throw new Error("Injected provider not available")
	}
	const accounts = await getAccounts(provider)
	if (!accounts || accounts.length === 0) {
		await enableProvider(provider)
	}
}

async function getWalletAsync(): Promise<Observable<EthereumWallet | undefined>> {
	const provider = getInjectedProvider()
	return combineLatest([getAddress(provider), getChainId(provider)]).pipe(
		map(([address, chainId]) => {
			if (address) {
				return { chainId, address, provider }
			} else {
				return undefined
			}
		}),
	)
}

async function enableProvider(provider: any) {
	if (typeof provider.request === "function") {
		try {
			await provider.request({
				method: "eth_requestAccounts",
			})
		} catch (e) {
			if (typeof provider.enable === "function") {
				await provider.enable()
			}
		}
	} else {
		if (typeof provider.enable === "function") {
			await provider.enable()
		}
	}
	return provider
}

function getAddress(provider: any): Observable<string | undefined> {
	return getObservable<string[], string | undefined>(
		provider,
		getAccounts,
		([account]) => account,
		"accountsChanged",
	)
}

function getChainId(provider: any): Observable<number> {
	return getObservable<string, number>(
		provider,
		ethChainId,
		raw => parseInt(raw),
		"chainChanged",
	)
}

function getObservable<Raw, T>(
	provider: any,
	getRaw: (provider: any) => Promise<Raw>,
	mapRaw: (raw: Raw) => T,
	eventName: string,
): Observable<T> {
	return new Observable<T>(subscriber => {
		const handler = (raw: Raw) => {
			subscriber.next(mapRaw(raw))
		}
		getRaw(provider).then(handler)
		provider.on(eventName, handler) //todo if on not supported poll
		subscriber.add(() => {
			provider.removeListener(eventName, handler)  //todo if removeListener not supported
		})
	})
}

function getInjectedProvider(): any | undefined {
	let provider: any
	if ((window as any).ethereum) {
		provider = (window as any).ethereum
		;(provider as any).autoRefreshOnNetworkChange = false
	} else if ((window as any).web3?.currentProvider) {
		provider = (window as any).web3.currentProvider
	}
	return provider
}

async function getAccounts(provider: any): Promise<string[]> {
	if ("request" in provider) {
		return provider.request({ method: "eth_accounts" })
	} else {
		return []
	}
}

async function ethChainId(provider: any): Promise<string> {
	if ("request" in provider) {
		return provider.request({ method: "eth_chainId" })
	} else {
		throw new Error("Not supported: eth_chainId")
	}
}

function getDappType(provider: any): Maybe<DappType> {
	if (provider !== undefined) {
		if (provider) {
			if (provider.isImToken) return DappType.ImToken
			if (provider.isDapper) return DappType.Dapper
			if (provider.isMetaMask) return DappType.Metamask
			if (provider.isTrust) return DappType.Trust
			if (provider.isGoWallet) return DappType.GoWallet
			if (provider.isAlphaWallet) return DappType.AlphaWallet
			if (provider.isStatus) return DappType.Status
			if (provider.isToshi) return DappType.Coinbase
			if (typeof (window as any).__CIPHER__ !== "undefined") return DappType.Cipher
			if (provider.constructor.name === "EthereumProvider") return DappType.Mist
			if (provider.constructor.name === "Web3FrameProvider") return DappType.Parity
			if (provider.constructor.name === "Web3ProviderEngine") return DappType.Mock
			return DappType.Generic
		}
	}

	return undefined
}

function isDappSupportAutoconnect(dapp: Maybe<DappType>): boolean {
	if (!dapp) {
		return false
	}

	const unsupportedDappTypes: Set<DappType> = new Set([DappType.Dapper])
	const disabledAutoLogin = new Set([DappType.Generic, DappType.Metamask])

	return !(unsupportedDappTypes.has(dapp) || disabledAutoLogin.has(dapp))
}