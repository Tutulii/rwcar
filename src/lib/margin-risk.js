const LIVE_MARGIN_STATES = new Set(['HEALTHY', 'MARGIN_CALL']);
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

function firstDefined(value, keys) {
  for (const key of keys) {
    if (value?.[key] !== undefined && value?.[key] !== null) return value[key];
  }
  return null;
}

export function selectMarginRiskDisplay(row, status = row?.status) {
  const usesLiveRisk = LIVE_MARGIN_STATES.has(String(status || '').toUpperCase());
  if (usesLiveRisk) {
    // When the API explicitly returns a null live field, keep it unavailable.
    // Falling through to the indexer's zero placeholder would falsely display
    // a healthy funded account as 0% LTV.
    return {
      collateralValue: owns(row, 'liveCollateralValue') ? row.liveCollateralValue : firstDefined(row, ['collateralValue']),
      ltvBps: owns(row, 'liveLtvBps') ? row.liveLtvBps : firstDefined(row, ['ltvBps', 'currentLtvBps']),
      usesLiveRisk: true,
      unavailable: row?.liveRiskStatus === 'UNAVAILABLE',
    };
  }
  return {
    collateralValue: firstDefined(row, ['collateralValue', 'liveCollateralValue']),
    ltvBps: firstDefined(row, ['ltvBps', 'currentLtvBps', 'liveLtvBps']),
    usesLiveRisk: false,
    unavailable: false,
  };
}
