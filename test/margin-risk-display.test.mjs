import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { selectMarginRiskDisplay } from '../src/lib/margin-risk.js';

describe('margin risk display selection', () => {
  it('uses live signed risk instead of indexed zero placeholders for healthy accounts', () => {
    assert.deepEqual(selectMarginRiskDisplay({
      status: 'HEALTHY',
      collateralValue: null,
      ltvBps: 0,
      liveCollateralValue: '1000000',
      liveLtvBps: '201',
      liveRiskStatus: 'AVAILABLE',
    }), {
      collateralValue: '1000000',
      ltvBps: '201',
      usesLiveRisk: true,
      unavailable: false,
    });
  });

  it('does not fall back to zero when the API explicitly marks live risk unavailable', () => {
    const result = selectMarginRiskDisplay({
      status: 'HEALTHY',
      collateralValue: null,
      ltvBps: 0,
      liveCollateralValue: null,
      liveLtvBps: null,
      liveRiskStatus: 'UNAVAILABLE',
    });
    assert.equal(result.collateralValue, null);
    assert.equal(result.ltvBps, null);
    assert.equal(result.unavailable, true);
  });

  it('prefers the immutable closeout snapshot after liquidation', () => {
    const result = selectMarginRiskDisplay({
      status: 'LIQUIDATING',
      collateralValue: '900000',
      ltvBps: 8501,
      liveCollateralValue: '800000',
      liveLtvBps: 9500,
    });
    assert.equal(result.collateralValue, '900000');
    assert.equal(result.ltvBps, 8501);
    assert.equal(result.usesLiveRisk, false);
  });
});
