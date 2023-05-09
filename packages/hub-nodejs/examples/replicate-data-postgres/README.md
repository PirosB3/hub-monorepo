## Replicate hub data into Postgres

This example shows you how you can quickly start ingesting data from a Farcaster hub into a traditional database like Postgres.

### Requirements

Note that these are rough guidelines. Recommend you over-allocate resources to accommodate eventual growth of the Farcaster network.

* **Node.js Application**
    * ~200MB for installing NPM packages
    * At most 1GB of RAM (typically around ~250MB is normally used)
* ~2GB of space on your Postgres server to store all active Farcaster messages.

If you are running both the Node.js application and Postgres instance locally on your own machine, this will take about 3-4 hours to complete a backfill. If you are running them on separate servers, it may take significantly longer since the latency between the application and Postgres has a significant effect on backfill time.

### Run locally (recommended for quick experimentation)

1. Clone the repo locally
2. Navigate to this directory with `cd packages/hub-nodejs/examples/replicate-data-postgres`
3. Run `yarn install` to install dependencies
4. Run `docker compose up -d` to start a Postgres instance ([install Docker](https://docs.docker.com/get-docker/) if you do not yet have it)
5. Run `yarn start`

To wipe your local data, run `docker compose down -v` from this directory.

### Running on Render

Render allows you to run a Node.js application and a Postgres server in the same private network, which results in a reasonably

1. Create a new Standard Postgres instance via Render's dashboard.
2. Create a new **Background Worker** and copy+paste the GitHub URL for the repo: git@github.com:farcasterxyz/hub-monorepo.git
  Disable Auto-Deploy

### Run on StackBlitz

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/farcasterxyz/hubble/tree/main/packages/hub-nodejs/examples/replicate-data-postgres)

Note: this will require you to specify `POSTGRES_URL`.

### What does it do?

This example application starts two high-level processes:

1. Backfills all existing data from the hub, one FID (user) at a time.
2. Subscribes to the hub's event stream to sync live events.

If left running, the backfill will eventually complete and the subscription will continue processing live events in real-time. You can therefore start the application and it will remain up to date with the hub you connected to.

If you stop the process and start it again, it will start the backfill process for each FID from the beginning (i.e. will download the same messages again, but ignoring messages it already has). It will start reading live events from the last event it saw from the event stream.

#### Examples of SQL queries

Note that you'll need to wait until a full backfill has completed before some queries will return correct data. But you could start querying data for specific users (especially those with lower FIDs) after a few minutes and start to get data.

Get the 10 most recent casts for a user:
```sql
select timestamp, text, mentions, mentions_positions, embeds from casts where fid = 2 order by timestamp desc limit 10
```

Get the number of likes for a user's last 20 casts:
```sql
select timestamp, (select count(*) from reactions where reaction_type = 1 and target_hash = casts.hash and target_fid = casts.fid) from casts where fid = 3 order by timestamp desc limit 20
```

Get the top-20 most recasted casts:
```sql
select c.hash, count(*) as recast_count from casts as c join reactions as r on r.target_hash = c.hash and r.target_fid = c.fid where r.reaction_type = 2 group by c.hash order by recast_count desc limit 20
```

See the list of tables below for the schema.

### Caveats

There are some important points to consider when using this example:

* **This is not intended to be used in production!**
  It's intended to be an easy-to-understand example of what a production implementation might look like, but it focuses on how to think about processing messages and events and the associated side effects.

* If you are running the Node.js application and Postgres DB on different servers, the time it takes to sync will be heavily dependent on the latency between those servers. It is strongly recommended that you connect these using a private network, rather than connecting to them over the public internet, which some platforms like Supabase, Vercel, etc. do (at time of writing). If you don't, the initial backfill will take significantly longer (potentially days).

* While the created tables have some indexes for query performance, they are not built to consider all query patterns.

### Database Tables

The following tables are automatically created in the Postgres DB:

#### `messages`

All Farcaster messages retrieved from the hub are stored in this table. Messages are never deleted, only soft-deleted (i.e. marked as deleted but not actually removed from the DB).

Column Name | Data Type | Description
-- | -- | --
id | `bigint` | Generic identifier specific to this DB (a.k.a. [surrogate key](https://en.wikipedia.org/wiki/Surrogate_key))
created_at | `timestamp without time zone` | When the row was first created in this DB (not the same as the message timestamp!)
updated_at | `timestamp without time zone` | When the row was last updated.
deleted_at | `timestamp without time zone` | When the message was deleted by the hub (e.g. in response to a `CastRemove` message, etc.)
pruned_at | `timestamp without time zone` | When the message was pruned by the hub.
revoked_at | `timestamp without time zone` | When the message was revoked by the hub due to revocation of the signer that signed the message.
timestamp | `timestamp without time zone` | Message timestamp in UTC.
fid | `bigint` | FID of the user that signed the message.
message_type | `smallint` | Message type.
hash | `bytea` | Message hash.
hash_scheme | `smallint` | Message hash scheme.
signature | `bytea` | Message signature.
signature_scheme | `smallint` | Message hash scheme.
signer | `bytea` | Signer used to sign this message.
raw | `bytea` | Raw bytes representing the serialized message [protobuf](https://protobuf.dev/).

#### `casts`

Represents a cast authored by a user.

Column Name | Data Type | Description
-- | -- | --
id | `bigint` | Generic identifier specific to this DB (a.k.a. [surrogate key](https://en.wikipedia.org/wiki/Surrogate_key))
created_at | `timestamp without time zone` | When the row was first created in this DB (not the same as the message timestamp!)
updated_at | `timestamp without time zone` | When the row was last updated.
deleted_at | `timestamp without time zone` | When the cast was considered deleted by the hub (e.g. in response to a `CastRemove` message, etc.)
timestamp | `timestamp without time zone` | Message timestamp in UTC.
fid | `bigint` | FID of the user that signed the message.
hash | `bytea` | Message hash.
parent_hash | `bytea` | If this cast was a reply, the hash of the parent cast. `null` otherwise.
parent_fid | `bigint` | If this cast was a reply, the FID of the author of the parent cast. `null` otherwise.
parent_url | `text` | If this cast was a reply to a URL (e.g. an NFT, a web URL, etc.), the URL. `null` otherwise.
text | `text` | The raw text of the cast with mentions removed.
embeds | `text[]` | Array of URLs that were embedded with this cast.
mentions | `bigint[]` | Array of FIDs mentioned in the cast.
mentions_positions | `smallint[]` | UTF8 byte offsets of the mentioned FIDs in the cast.

#### `reactions`

Represents a user reacting (liking or recasting) content.

Column Name | Data Type | Description
-- | -- | --
id | `bigint` | Generic identifier specific to this DB (a.k.a. [surrogate key](https://en.wikipedia.org/wiki/Surrogate_key))
created_at | `timestamp without time zone` | When the row was first created in this DB (not the same as the message timestamp!)
updated_at | `timestamp without time zone` | When the row was last updated.
deleted_at | `timestamp without time zone` | When the cast was considered deleted by the hub (e.g. in response to a `CastRemove` message, etc.)
timestamp | `timestamp without time zone` | Message timestamp in UTC.
fid | `bigint` | FID of the user that signed the message.
reaction_type | `smallint` | Type of reaction.
hash | `bytea` | Message hash.
target_hash | `bytea` | If target was a cast, the hash of the cast. `null` otherwise.
target_fid | `bigint` | If target was a cast, the FID of the author of the cast. `null` otherwise.
target_url | `text` | If target was a URL (e.g. NFT, a web URL, etc.), the URL. `null` otherwise.

#### `verifications`

Represents a user verifying something on the network. Currently, the only verification is proving ownership of an Ethereum wallet address.

Column Name | Data Type | Description
-- | -- | --
id | `bigint` | Generic identifier specific to this DB (a.k.a. [surrogate key](https://en.wikipedia.org/wiki/Surrogate_key))
created_at | `timestamp without time zone` | When the row was first created in this DB (not the same as the message timestamp!)
updated_at | `timestamp without time zone` | When the row was last updated.
deleted_at | `timestamp without time zone` | When the cast was considered deleted by the hub (e.g. in response to a `CastRemove` message, etc.)
timestamp | `timestamp without time zone` | Message timestamp in UTC.
fid | `bigint` | FID of the user that signed the message.
hash | `bytea` | Message hash.
claim | `jsonb` | JSON object in the form `{"address": "0x...", "blockHash": "0x...", "ethSignature": "0x..."}`. See [specification](https://github.com/farcasterxyz/protocol/blob/main/docs/SPECIFICATION.md#15-verifications) for details.

#### `signers`

Represents signers that users have registered as authorized to sign Farcaster messages on the user's behalf.

Column Name | Data Type | Description
-- | -- | --
id | `bigint` | Generic identifier specific to this DB (a.k.a. [surrogate key](https://en.wikipedia.org/wiki/Surrogate_key))
created_at | `timestamp without time zone` | When the row was first created in this DB (not the same as the message timestamp!)
updated_at | `timestamp without time zone` | When the row was last updated.
deleted_at | `timestamp without time zone` | When the cast was considered deleted by the hub (e.g. in response to a `CastRemove` message, etc.)
timestamp | `timestamp without time zone` | Message timestamp in UTC.
fid | `bigint` | FID of the user that signed the message.
hash | `bytea` | Message hash.
custody_address | `bytea` | The address of the FID that signed the `SignerAdd` message.
signer | `bytea` | The public key of the signer that was added.
name | `text` | User-specified human-readable name for the signer (e.g. the application it is used for).

#### `user_data`

Represents data associated with a user (e.g. profile photo, bio, username, etc.)

Column Name | Data Type | Description
-- | -- | --
id | `bigint` | Generic identifier specific to this DB (a.k.a. [surrogate key](https://en.wikipedia.org/wiki/Surrogate_key))
created_at | `timestamp without time zone` | When the row was first created in this DB (not the same as the message timestamp!)
updated_at | `timestamp without time zone` | When the row was last updated.
deleted_at | `timestamp without time zone` | When the cast was considered deleted by the hub (e.g. in response to a `CastRemove` message, etc.)
timestamp | `timestamp without time zone` | Message timestamp in UTC.
fid | `bigint` | FID of the user that signed the message.
hash | `bytea` | Message hash.
type | `smallint` | The type of user data (PFP, bio, username, etc.)
value | `text` | The string value of the field.

#### `fids`

Stores the custody address that owns a given FID (i.e. a Farcaster user).

Column Name | Data Type | Description
-- | -- | --
fid | `bigint` | Farcaster ID (the user ID)
created_at | `timestamp without time zone` | When the row was first created in this DB (not the same as when the user was created!)
updated_at | `timestamp without time zone` | When the row was last updated.
custody_address | `bytea` | ETH address of the wallet that owns the FID.