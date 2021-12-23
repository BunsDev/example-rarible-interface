import { combineLatest, defer, Observable } from "rxjs"
import { distinctUntilChanged, first, map, mergeMap, shareReplay, startWith } from "rxjs/operators"
import Web3 from "web3"
import type WalletConnectProvider from "@walletconnect/web3-provider"
import { AbstractConnectionProvider, ConnectionState, STATE_CONNECTING, STATE_DISCONNECTED } from "../provider"
import { EthereumWallet } from "./domain"
import { Maybe } from "../../common/maybe"
import { cache, noop, promiseToObservable } from "../common/utils"

export type WalletConnectConfig = {
	infuraId: string
	rpcMap: Record<number, string>
	networkId: number
}

type ConnectStatus = "connected" | "disconnected"

const PROVIDER_ID = "walletconnect" as const

export class WalletConnectConnectionProvider extends AbstractConnectionProvider<typeof PROVIDER_ID, EthereumWallet> {
	private readonly instance: Observable<WalletConnectProvider>
	private readonly connection: Observable<ConnectionState<EthereumWallet>>

	constructor(
		private readonly config: WalletConnectConfig
	) {
		super()
		this.instance = cache(() => this._connect())
		this.connection = defer(() => this.instance.pipe(
			mergeMap(getConnect),
			startWith(STATE_CONNECTING),
		))
	}

	private async _connect(): Promise<WalletConnectProvider> {
		const { default: WalletConnectProvider } = await import("@walletconnect/web3-provider")
		const provider = new WalletConnectProvider(this.config)
		await provider.enable()
		return provider
	}

	getId(): string {
		return PROVIDER_ID
	}

	getConnection() {
		return this.connection
	}

	getOption(): Promise<Maybe<typeof PROVIDER_ID>> {
		return Promise.resolve(PROVIDER_ID)
	}

	async isAutoConnected(): Promise<boolean> {
		return false
	}

	async isConnected(): Promise<boolean> {
		const sdk = await this.instance.pipe(first()).toPromise()
		return sdk.connected
	}
}

function getConnect(instance: WalletConnectProvider): Observable<ConnectionState<EthereumWallet>> {
	const web3 = new Web3(instance as any)

	let disconnectResolve: () => void;
	const disconnectPromise = new Promise<void>((resolve) => disconnectResolve = resolve)

	const disconnect = () => {
		disconnectResolve()
		instance.disconnect().then().catch(noop)
	}

	return combineLatest([
		promiseToObservable(getAddress(instance, web3, disconnectPromise)),
		promiseToObservable(getChainId(instance, web3, disconnectPromise)),
		promiseToObservable(getConnectedStatus(instance)),
	]).pipe(
		map(([address, chainId, status]) => {
			if (status === "connected" && address) {
				const wallet: EthereumWallet = { chainId, address, provider: web3, disconnect }
				return { status: "connected" as const, connection: wallet }
			} else {
				return STATE_DISCONNECTED
			}
		}),
	)
}

async function getAddress(instance: WalletConnectProvider, web3: Web3, disconnectPromise: Promise<void>): Promise<Observable<string | undefined>> {
	const initialAddress = (await web3.eth.getAccounts())?.[0]
	return new Observable<string | undefined>(subscriber => {
		function handler(addresses: string[]) {
			const [address] = addresses
			subscriber.next(address)
		}
		instance.on("accountsChanged", handler)
		disconnectPromise.then(() => {
			instance.removeListener("accountsChanged", handler)
		})
	}).pipe(startWith(initialAddress), distinctUntilChanged(), shareReplay(1))
}

async function getChainId(instance: WalletConnectProvider, web3: Web3, disconnectPromise: Promise<void>): Promise<Observable<number>> {
	const networkId = await web3.eth.getChainId()
	return new Observable<number>(subscriber => {
		function handler(networkId: number) {
			subscriber.next(networkId)
		}
		instance.on("chainChanged", handler)
		disconnectPromise.then(() => {
			instance.removeListener("chainChanged", handler)
		})
	}).pipe(startWith(networkId), distinctUntilChanged(), shareReplay(1))
}

async function getConnectedStatus(instance: WalletConnectProvider): Promise<Observable<ConnectStatus>> {
	return new Observable<ConnectStatus>(subscriber => {
		function handler() {
			subscriber.next("disconnected")
			instance.removeListener("disconnected", handler)
		}
		instance.on("disconnected", handler)
	}).pipe(startWith("connected" as ConnectStatus), distinctUntilChanged())
}