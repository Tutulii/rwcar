import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const json = (path) => JSON.parse(read(path));

describe('Railway deployment packaging', () => {
  it('uses separate Dockerfiles and bounded restart policies for every service', () => {
    const expected = {
      api: '/Dockerfile.api',
      indexer: '/Dockerfile.indexer',
      web: '/Dockerfile.web',
    };
    for (const [service, dockerfilePath] of Object.entries(expected)) {
      const config = json(`deploy/railway/${service}.railway.json`);
      assert.equal(config.$schema, 'https://railway.com/railway.schema.json');
      assert.equal(config.build.builder, 'DOCKERFILE');
      assert.equal(config.build.dockerfilePath, dockerfilePath);
      assert.equal(config.build.watchPatterns.includes(`/deploy/railway/${service}.railway.json`), true);
      assert.equal(config.deploy.restartPolicyType, 'ON_FAILURE');
      assert.equal(config.deploy.restartPolicyMaxRetries, 10);
    }
  });

  it('migrates and safely bootstraps before the API release starts', () => {
    const config = json('deploy/railway/api.railway.json');
    assert.deepEqual(config.deploy.preDeployCommand, [
      "sh -c 'node packages/db/dist/migrate.js && node packages/db/dist/bootstrap-uat.js'",
    ]);
    assert.equal(config.deploy.healthcheckPath, '/health');
  });

  it('passes all public frontend settings at Docker build time', () => {
    const dockerfile = read('Dockerfile.web');
    for (const key of ['VITE_PRIVY_APP_ID', 'VITE_API_URL', 'VITE_TRUSTED_V2_MANIFEST_JSON']) {
      assert.match(dockerfile, new RegExp(`ARG ${key}`));
      assert.match(dockerfile, new RegExp(`ENV ${key}=`));
    }
    assert.match(dockerfile, /COPY packages\/shared packages\/shared/);
    assert.match(dockerfile, /scripts\/serve-static\.mjs/);
  });

  it('excludes every local credential source from Docker build contexts', () => {
    const patterns = new Set(read('.dockerignore').split(/\r?\n/).filter(Boolean));
    for (const required of ['.git', '.secrets', '.env', '.env.*', 'node_modules', '**/node_modules']) {
      assert.equal(patterns.has(required), true, `missing .dockerignore pattern ${required}`);
    }
  });
});
