import * as protobufs from '@farcaster/protobufs';
import {
  ContactInfoContent,
  FarcasterNetwork,
  GossipAddressInfo,
  GossipMessage,
  HubState,
  IdRegistryEvent,
  Message,
  NameRegistryEvent,
} from '@farcaster/protobufs';
import {
  HubAsyncResult,
  HubError,
  HubResult,
  HubRpcClient,
  bytesToHexString,
  bytesToUtf8String,
  getHubRpcClient,
} from '@farcaster/utils';
import { PeerId } from '@libp2p/interface-peer-id';
import { peerIdFromBytes } from '@libp2p/peer-id';
import { publicAddressesFirst } from '@libp2p/utils/address-sort';
import { Multiaddr, multiaddr } from '@multiformats/multiaddr';
import { isIP } from 'net';
import { Result, ResultAsync, err, ok } from 'neverthrow';
import { EthEventsProvider, GoerliEthConstants } from '~/eth/ethEventsProvider';
import { GossipNode } from '~/network/p2p/gossipNode';
import { NETWORK_TOPIC_CONTACT, NETWORK_TOPIC_PRIMARY } from '~/network/p2p/protocol';
import SyncEngine from '~/network/sync/syncEngine';
import Server from '~/rpc/server';
import { getHubState, putHubState } from '~/storage/db/hubState';
import RocksDB from '~/storage/db/rocksdb';
import Engine from '~/storage/engine';
import { PruneMessagesJobScheduler } from '~/storage/jobs/pruneMessagesJob';
import { RevokeSignerJobQueue, RevokeSignerJobScheduler } from '~/storage/jobs/revokeSignerJob';
import { idRegistryEventToLog, logger, messageToLog, messageTypeToName, nameRegistryEventToLog } from '~/utils/logger';
import {
  addressInfoFromGossip,
  addressInfoToString,
  getPublicIp,
  ipFamilyToString,
  p2pMultiAddrStr,
} from '~/utils/p2p';
import {
  UpdateNameRegistryEventExpiryJobQueue,
  UpdateNameRegistryEventExpiryJobWorker,
} from './storage/jobs/updateNameRegistryEventExpiryJob';

export type HubSubmitSource = 'gossip' | 'rpc' | 'eth-provider';

export const APP_VERSION = process.env['npm_package_version'] ?? '1.0.0';
export const APP_NICKNAME = 'Farcaster Hub';

export interface HubInterface {
  engine: Engine;
  submitMessage(message: protobufs.Message, source?: HubSubmitSource): HubAsyncResult<void>;
  submitIdRegistryEvent(event: protobufs.IdRegistryEvent, source?: HubSubmitSource): HubAsyncResult<void>;
  submitNameRegistryEvent(event: protobufs.NameRegistryEvent, source?: HubSubmitSource): HubAsyncResult<void>;
  getHubState(): HubAsyncResult<protobufs.HubState>;
  putHubState(hubState: protobufs.HubState): HubAsyncResult<void>;
}

export interface HubOptions {
  /** Farcaster network */
  network: FarcasterNetwork;

  /** The PeerId of this Hub */
  peerId?: PeerId;

  /** Addresses to bootstrap the gossip network */
  bootstrapAddrs?: Multiaddr[];

  /** A list of PeerId strings to allow connections with */
  allowedPeers?: string[];

  /** IP address string in MultiAddr format to bind to */
  ipMultiAddr?: string;

  /** External IP address to announce to peers. If not provided, it'll fetch the IP from an external service */
  announceIp?: string;

  /** Port for libp2p to listen for gossip */
  gossipPort?: number;

  /** Port for the RPC Client */
  rpcPort?: number;

  /** Network URL of the IdRegistry Contract */
  ethRpcUrl?: string;

  /** Address of the IdRegistry contract  */
  IdRegistryAddress?: string;

  /** Name of the RocksDB instance */
  rocksDBName?: string;

  /** Resets the DB on start, if true */
  resetDB?: boolean;

  /**
   * Only allows the Hub to connect to and advertise local IP addresses
   *
   * Only used by tests
   */
  localIpAddrsOnly?: boolean;

  /** Cron schedule for revoke signer jobs */
  revokeSignerJobCron?: string;

  /** Cron schedule for prune messages job */
  pruneMessagesJobCron?: string;
}

/** @returns A randomized string of the format `rocksdb.tmp.*` used for the DB Name */
const randomDbName = () => {
  return `rocksdb.tmp.${(new Date().getUTCDate() * Math.random()).toString(36).substring(2)}`;
};

const log = logger.child({
  component: 'Hub',
});

export class Hub implements HubInterface {
  private options: HubOptions;
  private gossipNode: GossipNode;
  private rpcServer: Server;
  private contactTimer?: NodeJS.Timer;
  private rocksDB: RocksDB;
  private syncEngine: SyncEngine;

  private revokeSignerJobQueue: RevokeSignerJobQueue;
  private revokeSignerJobScheduler: RevokeSignerJobScheduler;
  private pruneMessagesJobScheduler: PruneMessagesJobScheduler;
  private updateNameRegistryEventExpiryJobQueue: UpdateNameRegistryEventExpiryJobQueue;
  private updateNameRegistryEventExpiryJobWorker: UpdateNameRegistryEventExpiryJobWorker;

  engine: Engine;
  ethRegistryProvider: EthEventsProvider;

  constructor(options: HubOptions) {
    this.options = options;
    this.rocksDB = new RocksDB(options.rocksDBName ? options.rocksDBName : randomDbName());
    this.gossipNode = new GossipNode();
    this.engine = new Engine(this.rocksDB, options.network);
    this.syncEngine = new SyncEngine(this.engine, this.rocksDB);

    this.rpcServer = new Server(this, this.engine, this.syncEngine, this.gossipNode);

    // Create the ETH registry provider, which will fetch ETH events and push them into the engine.
    this.ethRegistryProvider = EthEventsProvider.makeWithGoerli(
      this,
      options.ethRpcUrl ?? '',
      GoerliEthConstants.IdRegistryAddress,
      GoerliEthConstants.NameRegistryAddress
    );

    // Setup job queues
    this.revokeSignerJobQueue = new RevokeSignerJobQueue(this.rocksDB);
    this.updateNameRegistryEventExpiryJobQueue = new UpdateNameRegistryEventExpiryJobQueue(this.rocksDB);

    // Setup job schedulers/workers
    this.revokeSignerJobScheduler = new RevokeSignerJobScheduler(this.revokeSignerJobQueue, this.engine);
    this.pruneMessagesJobScheduler = new PruneMessagesJobScheduler(this.engine);
    this.updateNameRegistryEventExpiryJobWorker = new UpdateNameRegistryEventExpiryJobWorker(
      this.updateNameRegistryEventExpiryJobQueue,
      this.rocksDB,
      this.ethRegistryProvider
    );
  }

  get rpcAddress() {
    return this.rpcServer.address;
  }

  get gossipAddresses() {
    return this.gossipNode.multiaddrs ?? [];
  }

  /** Returns the Gossip peerId string of this Hub */
  get identity(): string {
    if (!this.gossipNode.isStarted() || !this.gossipNode.peerId) {
      throw new HubError('unavailable', 'cannot start gossip node without identity');
    }
    return this.gossipNode.peerId.toString();
  }

  /* Start the GossipNode and RPC server  */
  async start() {
    // See if we have to fetch the IP address
    if (!this.options.announceIp || this.options.announceIp.trim().length === 0) {
      const ipResult = await getPublicIp();
      if (ipResult.isErr()) {
        log.error(`failed to fetch public IP address, using ${this.options.ipMultiAddr}`, { error: ipResult.error });
      } else {
        this.options.announceIp = ipResult.value;
      }
    }
    await this.rocksDB.open();

    if (this.options.resetDB === true) {
      log.info('clearing rocksdb');
      await this.rocksDB.clear();
    }

    // Start the ETH registry provider first
    await this.ethRegistryProvider.start();

    // Start the sync engine
    await this.syncEngine.initialize();

    await this.gossipNode.start(this.options.bootstrapAddrs ?? [], {
      peerId: this.options.peerId,
      ipMultiAddr: this.options.ipMultiAddr,
      announceIp: this.options.announceIp,
      gossipPort: this.options.gossipPort,
      allowedPeerIdStrs: this.options.allowedPeers,
    });

    // Start the RPC server
    await this.rpcServer.start(this.options.rpcPort ? this.options.rpcPort : 0);
    this.registerEventHandlers();

    // Start cron tasks
    this.revokeSignerJobScheduler.start(this.options.revokeSignerJobCron);
    this.pruneMessagesJobScheduler.start(this.options.pruneMessagesJobCron);
  }

  async getContactInfoContent(): HubAsyncResult<ContactInfoContent> {
    const nodeMultiAddr = this.gossipAddresses[0] as Multiaddr;
    const family = nodeMultiAddr?.nodeAddress().family;
    const announceIp = this.options.announceIp ?? nodeMultiAddr?.nodeAddress().address;
    const gossipPort = nodeMultiAddr?.nodeAddress().port;
    const rpcPort = this.rpcServer.address?.map((addr) => addr.port).unwrapOr(0);

    const gossipAddressContactInfo = GossipAddressInfo.create({ address: announceIp, family, port: gossipPort });
    const rpcAddressContactInfo = GossipAddressInfo.create({ address: announceIp, family, port: rpcPort });

    const snapshot = await this.syncEngine.getSnapshot();
    return snapshot.map((snapshot) => {
      return ContactInfoContent.create({
        gossipAddress: gossipAddressContactInfo,
        rpcAddress: rpcAddressContactInfo,
        excludedHashes: snapshot.excludedHashes,
        count: snapshot.numMessages,
      });
    });
  }

  /** Stop the GossipNode and RPC Server */
  async stop() {
    log.info('stopping hub...');
    clearInterval(this.contactTimer);

    // First, stop the RPC server so we don't get any more messages
    await this.rpcServer.stop();

    // Stop cron tasks
    this.revokeSignerJobScheduler.stop();
    this.pruneMessagesJobScheduler.stop();

    // Stop sync and gossip
    await this.gossipNode.stop();
    await this.syncEngine.stop();

    // Stop the ETH registry provider
    await this.ethRegistryProvider.stop();

    // Close the DB, which will flush all data to disk
    await this.rocksDB.close();
    log.info('hub stopped');
  }

  async getHubState(): HubAsyncResult<HubState> {
    return ResultAsync.fromPromise(getHubState(this.rocksDB), (e) => e as HubError);
  }

  async putHubState(hubState: HubState): HubAsyncResult<void> {
    return await ResultAsync.fromPromise(putHubState(this.rocksDB, hubState), (e) => e as HubError);
  }

  async connectAddress(address: Multiaddr): HubAsyncResult<void> {
    return this.gossipNode.connectAddress(address);
  }

  /** ------------------------------------------------------------------------- */
  /*                                  Private Methods                           */
  /* -------------------------------------------------------------------------- */

  private async handleGossipMessage(gossipMessage: GossipMessage): HubAsyncResult<void> {
    const peerIdResult = Result.fromThrowable(
      () => peerIdFromBytes(gossipMessage.peerId ?? new Uint8Array([])),
      (error) => new HubError('bad_request.parse_failure', error as Error)
    )();
    if (peerIdResult.isErr()) {
      return Promise.resolve(err(peerIdResult.error));
    }
    const peerId = peerIdResult.value;

    if (gossipMessage.message) {
      const message = gossipMessage.message;

      // Get the RPC Client to use to merge this message
      const rpcClient = this.syncEngine.getRpcClientForPeerId(peerId.toString());
      if (rpcClient) {
        return this.syncEngine.mergeMessages([message], rpcClient).then((result) => result[0] as HubResult<void>);
      } else {
        log.error('No RPC clients available to merge message, attempting to merge directly into the engine');
        return this.submitMessage(message, 'gossip');
      }
    } else if (gossipMessage.idRegistryEvent) {
      return this.submitIdRegistryEvent(gossipMessage.idRegistryEvent, 'gossip');
    } else if (gossipMessage.contactInfoContent) {
      if (peerIdResult.isOk()) {
        await this.handleContactInfo(peerIdResult.value, gossipMessage.contactInfoContent);
      }
      return ok(undefined);
    } else {
      return err(new HubError('bad_request.invalid_param', 'invalid message type'));
    }
  }

  private async handleContactInfo(peerId: PeerId, message: ContactInfoContent) {
    // Updates the address book for this peer
    const gossipAddress = message.gossipAddress;
    if (gossipAddress) {
      const addressInfo = addressInfoFromGossip(gossipAddress);
      if (addressInfo.isErr()) {
        log.error(addressInfo.error, 'unable to parse gossip address for peer');
        return;
      }

      const p2pMultiAddrResult = p2pMultiAddrStr(addressInfo.value, peerId.toString()).map((addr: string) =>
        multiaddr(addr)
      );

      const res = Result.combine([p2pMultiAddrResult]).map(async ([multiaddr]) => {
        if (!this.gossipNode.addressBook) {
          return err(new HubError('unavailable', 'address book missing for gossipNode'));
        }

        return await ResultAsync.fromPromise(
          this.gossipNode.addressBook.add(peerId, [multiaddr]),
          (error) => new HubError('unavailable', error as Error)
        ).map(() => ok(undefined));
      });

      if (res.isErr()) {
        log.error({ error: res.error, message }, 'failed to add contact info to address book');
      }
    }

    const rpcClient = await this.getRPCClientForPeer(peerId, message);
    log.info({ identity: this.identity, peer: peerId }, 'received a Contact Info for sync');

    // Check if we already have this client
    if (rpcClient) {
      if (this.syncEngine.getRpcClientForPeerId(peerId.toString())) {
        log.info('Already have this client, skipping sync');
        return;
      } else {
        this.syncEngine.addRpcClientForPeerId(peerId.toString(), rpcClient);
        await this.syncEngine.diffSyncIfRequired(peerId.toString());
      }
    }
  }

  private async getRPCClientForPeer(peerId: PeerId, peer: ContactInfoContent): Promise<HubRpcClient | undefined> {
    /*
     * Find the peer's addrs from our peer list because we cannot use the address
     * in the contact info directly
     */
    if (!peer.rpcAddress) {
      return;
    }

    // prefer the advertised address if it's available
    const rpcAddressInfo = addressInfoFromGossip(peer.rpcAddress as GossipAddressInfo);
    if (rpcAddressInfo.isErr()) {
      log.error(rpcAddressInfo.error, 'unable to parse gossip address for peer');
      return;
    }

    if (isIP(rpcAddressInfo.value.address)) {
      return getHubRpcClient(`${rpcAddressInfo.value.address}:${rpcAddressInfo.value.port}`);
    }

    log.info({ peerId }, 'falling back to addressbook lookup for peer');
    const peerInfo = await this.gossipNode.getPeerInfo(peerId);
    if (!peerInfo) {
      log.info(
        { function: 'getRPCClientForPeer', identity: this.identity, peer: peer },
        `failed to find peer's address to request simple sync`
      );

      return;
    }

    // sorts addresses by Public IPs first
    const addr = peerInfo.addresses.sort((a, b) => publicAddressesFirst(a, b))[0];
    if (addr === undefined) {
      log.info(
        { function: 'getRPCClientForPeer', identity: this.identity, peer: peer },
        `peer found but no address is available to request sync`
      );

      return;
    }

    const nodeAddress = addr.multiaddr.nodeAddress();
    const ai = {
      address: nodeAddress.address,
      family: ipFamilyToString(nodeAddress.family),
      // Use the rpc port instead of the port used by libp2p
      port: rpcAddressInfo.value.port,
    };

    return getHubRpcClient(addressInfoToString(ai));
  }

  private registerEventHandlers() {
    // Subscribe to store events
    this.engine.eventHandler.on('mergeMessage', async (message: Message) => {
      if (protobufs.isSignerRemoveMessage(message)) {
        const revokeSignerPayload = RevokeSignerJobQueue.makePayload(
          message.data?.fid ?? 0,
          message.data?.signerBody?.signer ?? new Uint8Array()
        );
        if (revokeSignerPayload.isOk()) {
          // Revoke signer in one hour
          await this.revokeSignerJobQueue.enqueueJob(revokeSignerPayload.value);
        }
      }
    });

    this.engine.eventHandler.on('mergeIdRegistryEvent', async (event: IdRegistryEvent) => {
      const fromAddress = event.from;
      if (fromAddress && fromAddress.length > 0) {
        const revokeSignerPayload = RevokeSignerJobQueue.makePayload(event.fid, fromAddress);
        if (revokeSignerPayload.isOk()) {
          // Revoke eth address in one hour
          await this.revokeSignerJobQueue.enqueueJob(revokeSignerPayload.value);
        }
      }
    });

    // Subscribes to all relevant topics
    this.gossipNode.gossip?.subscribe(NETWORK_TOPIC_PRIMARY);
    this.gossipNode.gossip?.subscribe(NETWORK_TOPIC_CONTACT);

    this.gossipNode.on('message', async (_topic, message) => {
      await message.match(
        async (gossipMessage: GossipMessage) => {
          await this.handleGossipMessage(gossipMessage);
        },
        async (error: HubError) => {
          log.error(error, 'failed to decode message');
        }
      );
    });

    this.gossipNode.on('peerConnect', async () => {
      // When we connect to a new node, gossip out our contact info 1 second later.
      // The setTimeout is to ensure that we have a chance to receive the peer's info properly.
      setTimeout(async () => {
        (await this.getContactInfoContent())
          .map(async (contactInfo) => {
            log.info(
              { rpcAddress: contactInfo.rpcAddress?.address, rpcPort: contactInfo.rpcAddress?.port },
              'gossiping contact info'
            );
            await this.gossipNode.gossipContactInfo(contactInfo);
          })
          .mapErr((error) => {
            log.warn(error, 'failed get contact info content');
          });
      }, 1 * 1000);
    });

    this.gossipNode.on('peerDisconnect', async (connection) => {
      // Remove this peer's connection
      this.syncEngine.removeRpcClientForPeerId(connection.remotePeer.toString());
    });
  }

  /* -------------------------------------------------------------------------- */
  /*                               RPC Handler API                              */
  /* -------------------------------------------------------------------------- */

  async submitMessage(message: Message, source?: HubSubmitSource): HubAsyncResult<void> {
    // message is a reserved key in some logging systems, so we use submittedMessage instead
    const logMessage = log.child({ submittedMessage: messageToLog(message), source });

    const mergeResult = await this.engine.mergeMessage(message);

    mergeResult.match(
      () => {
        logMessage.info(
          `submitMessage success: fid ${message.data?.fid} merged ${messageTypeToName(
            message.data?.type
          )} ${bytesToHexString(message.hash)._unsafeUnwrap()}`
        );
      },
      (e) => {
        logMessage.error({ errCode: e.errCode }, `submitMessage error: ${e.message}`);
      }
    );

    return mergeResult;
  }

  async submitIdRegistryEvent(event: IdRegistryEvent, source?: HubSubmitSource): HubAsyncResult<void> {
    const logEvent = log.child({ event: idRegistryEventToLog(event), source });

    const mergeResult = await this.engine.mergeIdRegistryEvent(event);

    mergeResult.match(
      () => {
        logEvent.info(
          `submitIdRegistryEvent success: fid ${event.fid} assigned to ${bytesToHexString(
            event.to
          )._unsafeUnwrap()} in block ${event.blockNumber}`
        );
      },
      (e) => {
        logEvent.error({ errCode: e.errCode }, `submitIdRegistryEvent error: ${e.message}`);
      }
    );

    return mergeResult;
  }

  async submitNameRegistryEvent(event: NameRegistryEvent, source?: HubSubmitSource): HubAsyncResult<void> {
    const logEvent = log.child({ event: nameRegistryEventToLog(event), source });

    const mergeResult = await this.engine.mergeNameRegistryEvent(event);

    mergeResult.match(
      () => {
        logEvent.info(
          `submitNameRegistryEvent success: fname ${bytesToUtf8String(
            event.fname
          )._unsafeUnwrap()} assigned to ${bytesToHexString(event.to)._unsafeUnwrap()} in block ${event.blockNumber}`
        );
      },
      (e) => {
        logEvent.error({ errCode: e.errCode }, `submitNameRegistryEvent error: ${e.message}`);
      }
    );

    if (!event.expiry) {
      const payload = protobufs.UpdateNameRegistryEventExpiryJobPayload.create({ fname: event.fname });
      await this.updateNameRegistryEventExpiryJobQueue.enqueueJob(payload);
    }

    return mergeResult;
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Test API                                  */
  /* -------------------------------------------------------------------------- */

  async destroyDB() {
    await this.rocksDB.destroy();
  }
}