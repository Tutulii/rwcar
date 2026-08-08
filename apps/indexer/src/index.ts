import { createDatabase } from '@rwcar/db';
import { loadConfig, parseV2DeploymentSources } from './config.js';
import { RepoIndexer } from './indexer.js';
import { DefaultKeeper } from './keeper.js';
import { V2OracleHeartbeat } from './oracle-heartbeat.js';
import { V2ProtocolIndexer } from './v2-indexer.js';
import { V2AutomationWorker } from './v2-keeper.js';

const config = loadConfig();
const { db, pool } = createDatabase(config.DATABASE_URL);
const indexer = config.V1_INDEXER_ENABLED ? new RepoIndexer(config, db) : null;
const v2Sources = parseV2DeploymentSources(config);
const v2Indexer = v2Sources.length > 0 ? new V2ProtocolIndexer(config, db, v2Sources) : null;
const v2Automation = v2Sources.length > 0 && config.KEEPER_PRIVATE_KEY ? new V2AutomationWorker(config, db, v2Sources) : null;
const oracleHeartbeat = config.V2_ORACLE_HEARTBEAT_ENABLED ? new V2OracleHeartbeat(config, v2Sources) : null;
const keeper = config.V1_KEEPER_ENABLED && config.KEEPER_PRIVATE_KEY ? new DefaultKeeper(config, db) : null;

const shutdown = async () => {
  indexer?.stop();
  v2Indexer?.stop();
  v2Automation?.stop();
  oracleHeartbeat?.stop();
  keeper?.stop();
  await pool.end();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

if (!indexer) console.warn('V1 indexer disabled by configuration.');
if (!config.V1_KEEPER_ENABLED) console.warn('V1 lifecycle keeper disabled by configuration.');
else if (!keeper) console.warn('Lifecycle keeper disabled because KEEPER_PRIVATE_KEY is not configured.');
if (!v2Indexer) console.warn('V2 indexer disabled because V2_DEPLOYMENTS_JSON is empty.');
if (!oracleHeartbeat) console.warn('V2 oracle heartbeat disabled by configuration.');
await Promise.all([indexer?.run(), v2Indexer?.run(), keeper?.run(), v2Automation?.run(), oracleHeartbeat?.run()]);
