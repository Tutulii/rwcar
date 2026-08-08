import { useEffect, useState } from 'react';
import { apiRequest } from './lib/api.js';
import { formatUnits, parseUnits } from './lib/chain.js';

const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const pick = (value, keys, fallback = null) => {
  for (const key of keys) {
    if (value?.[key] !== undefined && value?.[key] !== null) return value[key];
  }
  return fallback;
};

const asBigInt = (value, fallback = 0n) => {
  try { return BigInt(value ?? fallback); } catch { return fallback; }
};

const ceilDiv = (numerator, denominator) => denominator > 0n ? (numerator + denominator - 1n) / denominator : 0n;
const short = (value) => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—';
const dateTime = (value) => value ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const percent = (bps) => `${(Number(bps || 0) / 100).toFixed(2)}%`;
const statusTitle = (value) => String(value || 'UNKNOWN').replaceAll('_', ' ').toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
const idOf = (row) => String(pick(row, ['positionId', 'auctionId', 'accountId', 'exposureId', 'offerId', 'id', 'repoId'], '—'));
const offerIdOf = (row) => String(pick(row, ['offerId', 'id', 'repoId'], '—'));
const positionIdOf = (row) => String(pick(row, ['positionId', 'id', 'repoId'], '—'));
const auctionIdOf = (row) => String(pick(row, ['auctionId', 'id'], '—'));
const accountIdOf = (row) => String(pick(row, ['accountId', 'id'], '—'));
const exposureIdOf = (row) => String(pick(row, ['exposureId', 'id'], '—'));
const asTime = (value) => {
  if (!value) return 0;
  if (/^\d+$/.test(String(value))) {
    const numeric = Number(value);
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  return new Date(value).getTime();
};

const chainNow = (clock) => {
  if (!clock?.chainTimeMs || !Number.isFinite(clock?.monotonicMs)) return Date.now();
  return clock.chainTimeMs + Math.max(0, performance.now() - clock.monotonicMs);
};

function durationLabel(seconds) {
  const value = Number(seconds || 0);
  if (value < 3600) return `${Math.max(1, Math.round(value / 60))} min`;
  if (value < 86400) return `${Math.round(value / 3600)} hr`;
  return `${Math.round(value / 86400)} days`;
}

function assetFor(assets, address) {
  return assets.find((asset) => asset.address?.toLowerCase() === address?.toLowerCase()) || null;
}

function amount(value, decimals = 6, suffix = '') {
  return `${formatUnits(asBigInt(value), Number(decimals), 4)}${suffix ? ` ${suffix}` : ''}`;
}

function V2Icon({ name, size = 18 }) {
  const paths = {
    vault: <><path d="M3 7h18v14H3z"/><path d="M7 7V4h10v3M8 13h8M12 10v6"/></>,
    auction: <><path d="m14 4 6 6M11 7l6 6M4 20l8-8M3 21h7"/></>,
    margin: <><path d="M4 19V5M4 19h16M8 15l3-4 3 2 5-7"/><path d="M17 6h2v2"/></>,
    shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></>,
    close: <path d="M18 6 6 18M6 6l12 12"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    wallet: <><path d="M20 7V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h16v10a2 2 0 0 1-2 2H5a3 3 0 0 1-3-3V6"/><path d="M16 14h2"/></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></>,
  };
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.info}</svg>;
}

function CvaSeal({ asset, compact = false }) {
  const issued = asset?.cleanverseStatus === 'ISSUED' && !asset?.paused;
  return <span className={`v2-cva-seal ${issued ? 'issued' : 'pending'} ${compact ? 'compact' : ''}`}><V2Icon name={issued ? 'check' : 'shield'} size={11}/>{issued ? 'CVA · Cleanverse Issued' : 'CVA verification unavailable'}</span>;
}

function StagePill({ value }) {
  return <span className={`v2-stage ${String(value || '').toLowerCase()}`}><i/>{statusTitle(value)}</span>;
}

function Modal({ title, eyebrow, onClose, children, footer }) {
  useEffect(() => {
    const close = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  return <div className="v2-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="v2-modal" role="dialog" aria-modal="true"><header><div><span>{eyebrow}</span><h3>{title}</h3></div><button type="button" onClick={onClose} aria-label="Close"><V2Icon name="close"/></button></header><div className="v2-modal-body">{children}</div>{footer && <footer>{footer}</footer>}</section></div>;
}

export function V2Unavailable({ state = 'unavailable', onRetry }) {
  const loading = state === 'loading';
  return <section className="card v2-unavailable"><span className="v2-unavailable-mark"><V2Icon name={loading ? 'clock' : 'vault'} size={27}/></span><span className="section-eyebrow">Institutional protocol V2</span><h3>{loading ? 'Checking the deployment registry' : 'V2 is not deployed on this environment'}</h3><p>{loading ? 'Reading the versioned protocol configuration from the RWCAR API.' : 'Direct-DvP V1 remains available. Vault custody, partial fills, auctions and cross-margin will activate here only after the contracts and indexer pass the deployment gate.'}</p><div className="v2-module-list"><span>Partial fills</span><span>Tri-party vault</span><span>Early repurchase</span><span>Dutch auctions</span><span>Cross-margin</span></div>{!loading && <button className="button secondary" type="button" onClick={onRetry}>Check deployment again</button>}</section>;
}

export function ExecutionStatus({ execution, explorerUrl }) {
  if (!execution || execution.stage === 'idle') return null;
  const copy = {
    preflight: ['Preflight verification', 'Checking live balances, allowances, CVI, CVA and protocol state.'],
    approval: ['Token approval required', execution.detail || 'Approve the exact amount in your wallet.'],
    signature: ['Wallet signature required', execution.detail || 'Review and sign the prepared Monad transaction.'],
    confirmation: ['Confirming on Monad', execution.detail || 'The transaction was submitted and is awaiting finality.'],
    indexing: ['Synchronizing records', 'The transaction is confirmed. Waiting for the institutional ledger projection.'],
    success: ['Execution complete', execution.detail || 'The finalized transaction is now reflected in RWCAR.'],
    error: ['Execution stopped', execution.detail || 'Review the failure and any submitted transaction hash before trying again.'],
  }[execution.stage] || ['Preparing execution', execution.detail || 'Preparing the requested action.'];
  return <aside className={`v2-execution ${execution.stage}`} role={execution.stage === 'error' ? 'alert' : 'status'}><span className="v2-execution-icon"><V2Icon name={execution.stage === 'success' ? 'check' : execution.stage === 'error' ? 'info' : 'clock'} size={16}/></span><div><strong>{copy[0]}</strong><small>{copy[1]}</small>{execution.code && <code>{execution.code}{execution.correlationId ? ` · ${execution.correlationId}` : ''}</code>}</div><StagePill value={execution.stage}/>{execution.txHash && <a href={`${explorerUrl || 'https://testnet.monadscan.com'}/tx/${execution.txHash}`} target="_blank" rel="noreferrer">View tx</a>}</aside>;
}

export function ProtocolSwitch({ value, onChange, v2State }) {
  return <div className="protocol-switch" aria-label="Protocol version"><button className={value === 'v2' ? 'active' : ''} onClick={() => onChange('v2')}><span>Vault Market</span><b>V2</b>{v2State === 'ready' ? <i className="ready"/> : <i/>}</button><button className={value === 'v1' ? 'active' : ''} onClick={() => onChange('v1')}><span>Direct DvP</span><b>V1</b></button></div>;
}

function offerTerms(row) {
  const totalPrincipal = asBigInt(pick(row, ['targetPrincipal', 'targetPrincipalAmount', 'principalAmount']));
  const remainingPrincipal = asBigInt(pick(row, ['remainingPrincipal', 'remainingPrincipalAmount'], totalPrincipal));
  const totalCollateral = asBigInt(pick(row, ['totalCollateral', 'collateralAmount']));
  const remainingCollateral = asBigInt(pick(row, ['remainingCollateral'], totalCollateral));
  const filledPrincipal = totalPrincipal > remainingPrincipal ? totalPrincipal - remainingPrincipal : asBigInt(pick(row, ['filledPrincipal'], 0));
  return { totalPrincipal, remainingPrincipal, totalCollateral, remainingCollateral, filledPrincipal };
}

function localFillQuote(row, principalRaw, asset) {
  const terms = offerTerms(row);
  const principal = asBigInt(principalRaw);
  const filledAfter = terms.filledPrincipal + principal;
  const allocatedBeforeFallback = terms.totalPrincipal > 0n ? terms.totalCollateral * terms.filledPrincipal / terms.totalPrincipal : 0n;
  const allocatedBefore = terms.totalCollateral >= terms.remainingCollateral ? terms.totalCollateral - terms.remainingCollateral : allocatedBeforeFallback;
  const allocatedAfter = principal === terms.remainingPrincipal
    ? terms.totalCollateral
    : terms.totalPrincipal > 0n ? terms.totalCollateral * filledAfter / terms.totalPrincipal : 0n;
  const collateral = allocatedAfter > allocatedBefore ? allocatedAfter - allocatedBefore : 0n;
  const rate = asBigInt(pick(row, ['annualRateBps', 'repoRateBps', 'rateBps']));
  const duration = asBigInt(pick(row, ['durationSeconds', 'termSeconds', 'duration']));
  const interest = ceilDiv(principal * rate * duration, 10_000n * SECONDS_PER_YEAR);
  const feeBps = asBigInt(pick(row, ['protocolFeeBps'], 0));
  const fee = ceilDiv(principal * feeBps, 10_000n);
  return {
    principal: principal.toString(),
    collateral: collateral.toString(),
    interest: interest.toString(),
    protocolFee: fee.toString(),
    sellerProceeds: (principal > fee ? principal - fee : 0n).toString(),
    scheduledPayoff: (principal + interest).toString(),
    maturityAt: new Date(Date.now() + Number(duration) * 1000).toISOString(),
    collateralDecimals: asset?.decimals ?? 6,
  };
}

export function V2Markets({ offers, assets, address, loading, busy, onAction, settlement = {}, entryEnabled = false }) {
  const settlementDecimals = Number(settlement.decimals ?? 6);
  const settlementSymbol = settlement.symbol || 'aUSDC';
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [fillAmount, setFillAmount] = useState('');
  const [formError, setFormError] = useState('');
  const [remoteFillQuote, setRemoteFillQuote] = useState(null);
  const [remoteQuoteError, setRemoteQuoteError] = useState('');
  const [quoteAttempt, setQuoteAttempt] = useState(0);
  const filtered = offers.filter((row) => {
    const asset = assetFor(assets, pick(row, ['assetAddress', 'asset']));
    return `${asset?.name || ''} ${asset?.symbol || ''} ${pick(row, ['seller'], '')}`.toLowerCase().includes(search.toLowerCase());
  });
  const selectedAsset = selected ? assetFor(assets, pick(selected, ['assetAddress', 'asset'])) : null;
  let indicativeQuote = null;
  if (selected && fillAmount) {
    try { indicativeQuote = localFillQuote(selected, parseUnits(fillAmount, settlementDecimals).toString(), selectedAsset); } catch { indicativeQuote = null; }
  }
  useEffect(() => {
    let active = true;
    setRemoteFillQuote(null);
    setRemoteQuoteError('');
    if (!selected || !fillAmount) return () => { active = false; };
    let principalAmount;
    try {
      const parsed = parseUnits(fillAmount, settlementDecimals);
      const terms = offerTerms(selected);
      const minimum = asBigInt(pick(selected, ['minimumFill', 'minimumFillAmount'], 0));
      if (parsed <= 0n || parsed > terms.remainingPrincipal) throw new Error('Fill must be greater than zero and no more than the remaining principal.');
      if (parsed < minimum && parsed !== terms.remainingPrincipal) throw new Error(`Minimum fill is ${formatUnits(minimum, settlementDecimals, settlementDecimals)} ${settlementSymbol} unless taking the final remainder.`);
      principalAmount = parsed.toString();
    } catch (reason) {
      setRemoteQuoteError(reason.message || 'Enter a valid fill amount.');
      return () => { active = false; };
    }
    const timer = window.setTimeout(() => {
      apiRequest(`/v2/offers/${offerIdOf(selected)}/quote?principalAmount=${principalAmount}`)
        .then((result) => { if (active) setRemoteFillQuote(result); })
        .catch((reason) => { if (active) setRemoteQuoteError(reason.message || 'The live quote is temporarily unavailable.'); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [selected, fillAmount, settlementDecimals, settlementSymbol, quoteAttempt]);
  const quote = indicativeQuote ? { ...indicativeQuote, ...(remoteFillQuote || {}), protocolFee: remoteFillQuote?.openingFee ?? indicativeQuote.protocolFee } : null;
  const openFill = (row) => {
    const terms = offerTerms(row);
    const minimum = asBigInt(pick(row, ['minimumFill', 'minimumFillAmount'], terms.remainingPrincipal));
    setFillAmount(formatUnits(minimum > terms.remainingPrincipal ? terms.remainingPrincipal : minimum, settlementDecimals, settlementDecimals));
    setFormError('');
    setSelected(row);
  };
  const submit = async () => {
    try {
      if (!entryEnabled) throw new Error('New repo entry is paused. Existing positions and recovery paths remain available.');
      if (!remoteFillQuote) throw new Error('Wait for the live protocol quote before signing.');
      const principalAmount = parseUnits(fillAmount, settlementDecimals);
      const terms = offerTerms(selected);
      const minimum = asBigInt(pick(selected, ['minimumFill', 'minimumFillAmount'], 0));
      if (principalAmount <= 0n || principalAmount > terms.remainingPrincipal) throw new Error('Fill must be greater than zero and no more than the remaining principal.');
      if (principalAmount < minimum && principalAmount !== terms.remainingPrincipal) throw new Error(`Minimum fill is ${formatUnits(minimum, settlementDecimals, settlementDecimals)} ${settlementSymbol} unless taking the final remainder.`);
      setFormError('');
      const result = await onAction('fill', { actor: address, offerId: offerIdOf(selected), principalAmount: principalAmount.toString() }, 'Partial fill settled into the tri-party vault.');
      if (result?.ok) setSelected(null);
    } catch (reason) { setFormError(reason.message); }
  };
  return <div className="v2-workspace"><div className="v2-workspace-bar"><div><span className="section-eyebrow">Tri-party liquidity</span><h3>Vault-settled repo offers</h3></div><span className="v2-live"><i/>V2 indexed</span></div>{!entryEnabled && <div className="v2-feature-gate"><V2Icon name="info" size={15}/><div><strong>New repo entry is paused</strong><small>Market history and recovery remain visible; new fills are disabled until custody readiness is restored.</small></div></div>}<section className="card v2-market-card"><div className="v2-tools"><label className="search-box"><V2Icon name="info"/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search CVA or seller"/></label><span>{filtered.length} fillable offers · {settlementSymbol} settlement</span></div>{loading ? <div className="v2-loading">Loading finalized V2 offers…</div> : filtered.length ? <div className="table-wrap"><table><thead><tr><th>Verified asset</th><th>Fill progress</th><th>Remaining</th><th>Min. fill</th><th>Rate / term</th><th>Seller</th><th/></tr></thead><tbody>{filtered.map((row) => {
    const asset = assetFor(assets, pick(row, ['assetAddress', 'asset']));
    const terms = offerTerms(row);
    const progress = terms.totalPrincipal > 0n ? Number(terms.filledPrincipal * 10_000n / terms.totalPrincipal) / 100 : 0;
    const mine = pick(row, ['seller'], '').toLowerCase() === address?.toLowerCase();
    const permittedBuyer = pick(row, ['permittedBuyer']);
    const targeted = Boolean(permittedBuyer && permittedBuyer.toLowerCase() !== ZERO_ADDRESS);
    const buyerPermitted = !targeted || permittedBuyer.toLowerCase() === address?.toLowerCase();
    return <tr key={offerIdOf(row)}><td><div className="asset-cell"><span className="asset-monogram large">{(asset?.symbol || 'CVA').slice(0,2)}</span><div><strong>{asset?.name || short(pick(row, ['assetAddress', 'asset']))}</strong><CvaSeal asset={asset} compact/></div></div></td><td><div className="v2-progress"><div><span style={{ width: `${Math.min(100, progress)}%` }}/></div><strong>{progress.toFixed(1)}%</strong><small>{amount(terms.filledPrincipal, settlementDecimals)} of {amount(terms.totalPrincipal, settlementDecimals)}</small></div></td><td className="number">{amount(terms.remainingPrincipal, settlementDecimals, settlementSymbol)}</td><td>{amount(pick(row, ['minimumFill', 'minimumFillAmount'], terms.remainingPrincipal), settlementDecimals, settlementSymbol)}</td><td><strong className="gold-text">{percent(pick(row, ['annualRateBps', 'repoRateBps', 'rateBps']))}</strong><small className="v2-subline">{durationLabel(pick(row, ['durationSeconds', 'termSeconds', 'duration']))} per fill</small></td><td><strong>{short(pick(row, ['seller']))}</strong><small className="v2-compliant">✓ CVI rechecked at fill</small></td><td><button className="table-action" disabled={busy || mine || !address || !buyerPermitted || !entryEnabled} onClick={() => openFill(row)}>{mine ? 'Your offer' : !entryEnabled ? 'Entry paused' : !buyerPermitted ? 'Targeted offer' : 'Quote fill'}</button></td></tr>;
  })}</tbody></table></div> : <div className="v2-empty"><V2Icon name="vault" size={25}/><strong>No V2 offers are currently fillable</strong><p>Partially filled offers remain here until their final allocation or expiry.</p></div>}</section>{selected && <Modal eyebrow={`Offer #${offerIdOf(selected)}`} title="Review partial fill" onClose={() => setSelected(null)} footer={<><button className="button secondary" onClick={() => setSelected(null)}>Cancel</button><button className="button primary" disabled={busy || !remoteFillQuote} onClick={submit}>{busy ? 'Execution in progress…' : remoteFillQuote ? 'Verify & Fill Offer' : 'Loading live quote…'}</button></>}><div className="v2-modal-asset"><span className="asset-monogram large">{(selectedAsset?.symbol || 'CVA').slice(0,2)}</span><div><strong>{selectedAsset?.name || 'Cleanverse asset'}</strong><CvaSeal asset={selectedAsset}/></div></div><label className="field"><span>Fill principal</span><div className="input-affix"><input inputMode="decimal" value={fillAmount} onChange={(event) => setFillAmount(event.target.value)}/><b>{settlementSymbol}</b></div></label>{remoteQuoteError && <div className="v2-form-error"><span>{remoteQuoteError}</span><button type="button" className="table-action" onClick={() => setQuoteAttempt((value) => value + 1)}>Retry quote</button></div>}{quote && <dl className="v2-quote"><div><dt>Allocated collateral</dt><dd>{amount(quote.collateral, quote.collateralDecimals, selectedAsset?.symbol || 'CVA')}</dd></div><div><dt>Seller proceeds</dt><dd>{amount(quote.sellerProceeds, settlementDecimals, settlementSymbol)}</dd></div><div><dt>Opening fee</dt><dd>{amount(quote.protocolFee, settlementDecimals, settlementSymbol)}</dd></div><div><dt>Scheduled interest</dt><dd>{amount(quote.interest, settlementDecimals, settlementSymbol)}</dd></div><div><dt>Scheduled payoff</dt><dd className="gold-text">{amount(quote.scheduledPayoff, settlementDecimals, settlementSymbol)}</dd></div><div><dt>Your maturity</dt><dd>{dateTime(quote.maturityAt)}</dd></div></dl>}<p className="v2-disclosure"><V2Icon name="info" size={13}/>{remoteFillQuote ? 'The allocation and opening fee come from the protocol API. Live state is checked again before signature.' : 'Waiting for the server-derived quote; indicative browser math cannot authorize a transaction.'}</p>{formError && <div className="v2-form-error">{formError}</div>}</Modal>}</div>;
}

export function V2CreateOffer({ assets, balances, marginAccounts, config, address, busy, onAction, settlement = {}, preferredMarginAccount, chainClock = null, entryEnabled = false }) {
  const settlementDecimals = Number(settlement.decimals ?? 6);
  const settlementSymbol = settlement.symbol || 'aUSDC';
  const durations = config?.terms?.allowedDurations || config?.risk?.allowedDurations || [300, 604800, 1209600, 2592000];
  const maxExpiryMinutes = Math.floor(Number(config?.terms?.maxOfferLifetimeSeconds ?? 30 * 86400) / 60);
  const [assetAddress, setAssetAddress] = useState(assets[0]?.address || '');
  const [collateral, setCollateral] = useState('10');
  const [principal, setPrincipal] = useState('1');
  const [minimumFill, setMinimumFill] = useState('0.25');
  const [rate, setRate] = useState('5.75');
  const [duration, setDuration] = useState(String(durations[0] || 300));
  const [expiryMinutes, setExpiryMinutes] = useState('60');
  const [permittedBuyer, setPermittedBuyer] = useState('');
  const [earlyRepurchaseEnabled, setEarlyRepurchaseEnabled] = useState(true);
  const [marginAccountId, setMarginAccountId] = useState(preferredMarginAccount ? accountIdOf(preferredMarginAccount) : '');
  const [formError, setFormError] = useState('');
  useEffect(() => { if (!assetAddress && assets[0]) setAssetAddress(assets[0].address); }, [assetAddress, assets]);
  useEffect(() => { if (preferredMarginAccount) setMarginAccountId(accountIdOf(preferredMarginAccount)); }, [preferredMarginAccount]);
  const selectedAsset = assetFor(assets, assetAddress);
  const selectedBalance = balances.find((row) => pick(row, ['assetAddress', 'asset'])?.toLowerCase() === assetAddress?.toLowerCase());
  const available = asBigInt(pick(selectedBalance, ['available', 'availableBalance'], 0));
  const submit = async (event) => {
    event.preventDefault();
    try {
      if (!entryEnabled) throw new Error('New repo entry is paused until the custody readiness gate is restored.');
      if (!selectedAsset) throw new Error('Select a Cleanverse-issued asset.');
      const collateralAmount = parseUnits(collateral, selectedAsset.decimals ?? 6);
      const targetPrincipal = parseUnits(principal, settlementDecimals);
      const minimumFillAmount = parseUnits(minimumFill, settlementDecimals);
      if (collateralAmount <= 0n || targetPrincipal <= 0n) throw new Error('Collateral and target principal must be greater than zero.');
      if (marginAccountId) throw new Error('Shared-collateral exposure creation is gated until the final MarginEngine ABI is deployed. Select the isolated vault for this transaction.');
      if (minimumFillAmount <= 0n || minimumFillAmount > targetPrincipal) throw new Error('Minimum fill must be greater than zero and no more than target principal.');
      const durationSeconds = Number(duration);
      const validityMinutes = Number(expiryMinutes);
      if (!Number.isSafeInteger(validityMinutes) || validityMinutes < 1 || validityMinutes > maxExpiryMinutes) throw new Error(`Offer validity must be between 1 and ${maxExpiryMinutes} minutes.`);
      const body = {
        seller: address,
        asset: selectedAsset.address,
        totalCollateral: collateralAmount.toString(),
        targetPrincipal: targetPrincipal.toString(),
        minimumFill: minimumFillAmount.toString(),
        annualRateBps: Math.round(Number(rate) * 100),
        durationSeconds,
        offerExpiry: Math.floor(chainNow(chainClock) / 1000) + validityMinutes * 60,
        permittedBuyer: permittedBuyer || null,
        earlyRepurchaseEnabled,
      };
      setFormError('');
      const result = await onAction('create-offer', body, 'Vault-settled partial-fill offer created.');
      if (result?.ok) {
        setCollateral('');
        setPrincipal('');
        setMinimumFill('');
      }
    } catch (reason) { setFormError(reason.message); }
  };
  return <form className="create-grid" onSubmit={submit}><section className="card form-card"><div className="form-section-title"><span>V2</span><div><h3>Vault-settled commercial terms</h3><p>Collateral is reserved in custody at offer creation and allocated cumulatively across fills.</p></div></div>{!entryEnabled && <div className="v2-feature-gate"><V2Icon name="info" size={15}/><div><strong>New repo entry is paused</strong><small>Existing positions remain fully closeable while operations verifies custody readiness.</small></div></div>}{assets.length ? <><div className="field"><label>Cleanverse-issued collateral</label><div className="custom-select"><select value={assetAddress} onChange={(event) => setAssetAddress(event.target.value)}>{assets.map((asset) => <option key={asset.address} value={asset.address}>{asset.name} ({asset.symbol})</option>)}</select><CvaSeal asset={selectedAsset}/></div><span className="field-hint">Available vault balance: {amount(available, selectedAsset?.decimals ?? 6, selectedAsset?.symbol || 'CVA')}</span></div><div className="field"><label>Collateral source</label><select className="plain-input" value={marginAccountId} onChange={(event) => setMarginAccountId(event.target.value)}><option value="">Isolated tri-party vault</option>{marginAccounts.map((account) => <option key={accountIdOf(account)} value={accountIdOf(account)}>Master netting set #{accountIdOf(account)} · feature gated</option>)}</select>{marginAccountId && <span className="field-hint danger-text">Shared-collateral exposure execution remains disabled until the final MarginEngine ABI is live.</span>}</div><div className="field-row"><div className="field"><label>Total collateral</label><div className="input-affix"><input inputMode="decimal" value={collateral} onChange={(event) => setCollateral(event.target.value)}/><b>{selectedAsset?.symbol || 'CVA'}</b></div></div><div className="field"><label>Target principal</label><div className="input-affix"><input inputMode="decimal" value={principal} onChange={(event) => setPrincipal(event.target.value)}/><b>{settlementSymbol}</b></div></div></div><div className="field-row"><div className="field"><label>Minimum fill</label><div className="input-affix"><input inputMode="decimal" value={minimumFill} onChange={(event) => setMinimumFill(event.target.value)}/><b>{settlementSymbol}</b></div></div><div className="field"><label>Annual repo rate</label><div className="input-affix"><input type="number" min="0" step="0.01" value={rate} onChange={(event) => setRate(event.target.value)}/><b>% APR</b></div></div></div><div className="field-row"><div className="field"><label>Per-fill term</label><select className="plain-input" value={duration} onChange={(event) => setDuration(event.target.value)}>{durations.map((seconds) => <option key={String(seconds)} value={String(seconds)}>{durationLabel(seconds)}</option>)}</select></div><div className="field"><label>Offer validity</label><div className="input-affix"><input type="number" min="1" max={maxExpiryMinutes} value={expiryMinutes} onChange={(event) => setExpiryMinutes(event.target.value)}/><b>minutes</b></div></div></div><div className="field"><label>Permitted buyer (optional)</label><input className="plain-input" value={permittedBuyer} onChange={(event) => setPermittedBuyer(event.target.value)} placeholder="0x… or leave public"/></div><label className="v2-checkbox"><input type="checkbox" checked={earlyRepurchaseEnabled} onChange={(event) => setEarlyRepurchaseEnabled(event.target.checked)}/><span><strong>Allow early repurchase</strong><small>ACT/365 actual elapsed interest with server-derived minimum hold and break fee</small></span></label>{formError && <div className="v2-form-error">{formError}</div>}</> : <div className="v2-empty"><strong>No approved V2 collateral</strong><p>A Cleanverse-issued asset and registered Vault are required.</p></div>}</section><aside className="create-aside"><section className="card verification-panel"><div className="panel-heading"><span className="shield-large"><V2Icon name="shield"/></span><div><h3>Institutional preflight</h3><p>Live checks immediately before signature</p></div></div><div className="verification-list"><div className="verification-item"><span className="check-circle pending"><V2Icon name="clock" size={13}/></span><div><strong>CVI + CVA eligibility</strong><small>Checked live on submission</small></div></div><div className="verification-item"><span className="check-circle pending"><V2Icon name="clock" size={13}/></span><div><strong>Vault encumbrance</strong><small>Checked live on submission</small></div></div><div className="verification-item"><span className="check-circle pending"><V2Icon name="clock" size={13}/></span><div><strong>Signed valuation</strong><small>Checked live on submission</small></div></div></div></section><section className="card execution-panel"><h3>Offer structure</h3><dl><div><dt>Fill model</dt><dd>Partial · cumulative pro-rata</dd></div><div><dt>Maturity</dt><dd>Independent per fill</dd></div><div><dt>Custody</dt><dd>Tri-party Vault</dd></div><div><dt>Early payoff</dt><dd>{earlyRepurchaseEnabled ? 'Enabled' : 'At maturity only'}</dd></div><div><dt>Collateral source</dt><dd>{marginAccountId ? `Netting set #${marginAccountId}` : 'Isolated vault'}</dd></div></dl><button type="submit" className="button primary full" disabled={busy || !entryEnabled || !address || !selectedAsset || !collateral || !principal || !minimumFill || Boolean(marginAccountId)}>{busy ? 'Verification / signature in progress…' : !entryEnabled ? 'New entry paused' : marginAccountId ? 'MarginEngine ABI pending' : 'Verify & Create V2 Offer'}</button><p className="onchain-assurance"><V2Icon name="shield" size={12}/>Final terms are immutable after the first fill</p></section></aside></form>;
}

function payoffFor(position) {
  const principal = asBigInt(pick(position, ['principalAmount', 'principal']));
  const accepted = new Date(pick(position, ['acceptedAt', 'openedAt'], Date.now())).getTime();
  const elapsed = BigInt(Math.max(0, Math.floor((Date.now() - accepted) / 1000)));
  const duration = asBigInt(pick(position, ['durationSeconds', 'termSeconds'], elapsed));
  const minimumHold = asBigInt(pick(position, ['minimumHoldSeconds'], duration / 10n));
  const chargeable = elapsed > minimumHold ? elapsed : minimumHold;
  const rate = asBigInt(pick(position, ['annualRateBps', 'repoRateBps', 'rateBps']));
  const accrued = ceilDiv(principal * rate * chargeable, 10_000n * SECONDS_PER_YEAR);
  const breakFee = ceilDiv(principal * asBigInt(pick(position, ['breakFeeBps'], 10)), 10_000n);
  const scheduled = ceilDiv(principal * rate * duration, 10_000n * SECONDS_PER_YEAR);
  const compensation = accrued + breakFee > scheduled ? scheduled : accrued + breakFee;
  return { principal, accrued, defaultInterest: 0n, breakFee, compensation, payoff: principal + compensation };
}

export function V2Portfolio({ portfolio, claims = [], assets, address, loading, busy, onAction, settlement = {}, chainClock = null }) {
  const settlementDecimals = Number(settlement.decimals ?? 6);
  const settlementSymbol = settlement.symbol || 'aUSDC';
  const [tab, setTab] = useState('seller');
  const [repay, setRepay] = useState(null);
  const [remotePayoff, setRemotePayoff] = useState(null);
  const [remotePayoffError, setRemotePayoffError] = useState('');
  const [payoffAttempt, setPayoffAttempt] = useState(0);
  const [claimIntent, setClaimIntent] = useState(null);
  const [claimAmount, setClaimAmount] = useState('');
  const [formError, setFormError] = useState('');
  const [, setClockTick] = useState(0);
  const sellerOffers = portfolio?.sellerOffers || [];
  const sellerPositions = portfolio?.sellerPositions || [];
  const lenderPositions = portfolio?.lenderPositions || [];
  const history = portfolio?.history || [];
  const pendingClaims = claims.filter((row) => String(row.status || '').toUpperCase() === 'PENDING' && asBigInt(pick(row, ['remaining', 'remainingAmount'])) > 0n);
  const now = chainNow(chainClock);
  const tabs = [
    { id: 'seller', label: 'Seller offers', rows: [...sellerOffers, ...sellerPositions] },
    { id: 'lender', label: 'Lender positions', rows: lenderPositions },
    { id: 'history', label: 'History', rows: history },
  ];
  const selected = tabs.find((item) => item.id === tab) || tabs[0];
  useEffect(() => {
    const timer = window.setInterval(() => setClockTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    setRemotePayoff(null);
    setRemotePayoffError('');
    if (!repay) return () => { active = false; };
    const refresh = () => apiRequest(`/v2/positions/${positionIdOf(repay)}/payoff`)
      .then((result) => { if (active) { setRemotePayoff({ ...result, receivedAtMonotonic: performance.now() }); setRemotePayoffError(''); } })
      .catch((reason) => { if (active) setRemotePayoffError(reason.message || 'The live payoff is temporarily unavailable.'); });
    void refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [repay, payoffAttempt]);
  const localPayoff = repay ? payoffFor(repay) : null;
  const quote = remotePayoff ? {
    principal: asBigInt(remotePayoff.principal),
    accrued: asBigInt(remotePayoff.contractualInterest),
    defaultInterest: asBigInt(remotePayoff.defaultInterest),
    breakFee: asBigInt(remotePayoff.breakFee),
    payoff: asBigInt(remotePayoff.payoff),
  } : localPayoff;
  const ceilingRate = repay ? [asBigInt(pick(repay, ['annualRateBps', 'repoRateBps', 'rateBps'])), asBigInt(pick(repay, ['defaultRateBps']))].reduce((maximum, value) => value > maximum ? value : maximum, 0n) : 0n;
  const payoffDriftBuffer = quote ? ceilDiv(quote.principal * ceilingRate * 300n, 10_000n * SECONDS_PER_YEAR) + 1n : 0n;
  const payoffCeiling = quote ? quote.payoff + payoffDriftBuffer : 0n;
  const payoffFresh = Boolean(remotePayoff && performance.now() - remotePayoff.receivedAtMonotonic <= 30_000);
  const lifecycleAction = (row, isOffer) => {
    const status = String(row.status || '').toUpperCase();
    if (isOffer && ['OPEN', 'PARTIALLY_FILLED'].includes(status)) {
      const expired = asTime(pick(row, ['offerExpiry', 'expiresAt'])) > 0 && now > asTime(pick(row, ['offerExpiry', 'expiresAt']));
      return <button className="table-action" disabled={busy} onClick={() => onAction(expired ? 'finalize-offer-expiry' : 'cancel-offer', { actor: address, offerId: offerIdOf(row) }, expired ? 'Expired offer finalized and all unfilled collateral released.' : 'Offer cancelled and all unfilled collateral released.')}>{expired ? 'Finalize expiry' : 'Cancel offer'}</button>;
    }
    if (!isOffer && ['ACTIVE', 'DEFAULT_ELIGIBLE'].includes(status)) {
      const deadline = asTime(pick(row, ['repaymentDeadline', 'graceEndsAt', 'deadlineAt']));
      const defaultEligible = status === 'DEFAULT_ELIGIBLE' || (deadline > 0 && now > deadline);
      const staleOracleDelay = Number(pick(row, ['staleOracleFallbackDelay', 'staleOracleFallbackDelaySeconds'], 0)) * 1000;
      const oracleFallbackEligible = defaultEligible && staleOracleDelay > 0 && now > deadline + staleOracleDelay;
      // The contract deliberately permits a deterministic late cure until an auction
      // transaction wins ordering. Never hide that seller exit merely because grace elapsed.
      if (tab === 'seller') return <button className="table-action" disabled={busy} onClick={() => setRepay(row)}>{defaultEligible ? 'Late cure payoff' : 'View payoff'}</button>;
      if (defaultEligible) return <div className="v2-row-actions"><button className="table-action danger" disabled={busy} onClick={() => onAction('start-auction', { actor: address, positionId: positionIdOf(row) }, 'Default crystallized and the compliant Dutch auction started.')}>Start auction</button>{oracleFallbackEligible && <button className="table-action" disabled={busy} onClick={() => onAction('claim-oracle-fallback', { actor: address, positionId: positionIdOf(row), recipient: address }, 'Stale-oracle closeout released collateral to the eligible lender.')}>Oracle fallback</button>}</div>;
    }
    if (!isOffer && status === 'AUCTION_FAILED' && tab === 'lender') return <button className="table-action" disabled={busy} onClick={() => onAction('claim-collateral', { actor: address, positionId: positionIdOf(row) }, 'Eligible lender collateral claim finalized from the vault.')}>Claim collateral</button>;
    return <span className="v2-row-note">{isOffer ? statusTitle(row.status) : 'Independent fill'}</span>;
  };
  const openClaim = (row) => {
    setClaimIntent(row);
    setClaimAmount(formatUnits(asBigInt(pick(row, ['remaining', 'remainingAmount'])), settlementDecimals, settlementDecimals));
    setFormError('');
  };
  const submitClaim = async () => {
    try {
      const rawAmount = parseUnits(claimAmount, settlementDecimals);
      const remaining = asBigInt(pick(claimIntent, ['remaining', 'remainingAmount']));
      if (rawAmount <= 0n || rawAmount > remaining) throw new Error('Claim amount must be greater than zero and no more than the remaining balance.');
      setFormError('');
      const result = await onAction('claim-settlement', {
        actor: address,
        claimId: String(pick(claimIntent, ['claimId', 'id'])),
        escrowAddress: pick(claimIntent, ['escrowAddress']),
        amount: rawAmount.toString(),
        recipient: address,
      }, 'Settlement proceeds withdrawn from beneficiary-specific escrow.');
      if (result?.ok) setClaimIntent(null);
    } catch (reason) {
      setFormError(reason.message || 'Enter a valid claim amount.');
    }
  };
  const submitRepay = async () => {
    if (!repay || !payoffFresh) return;
    const result = await onAction('repay', {
      actor: address,
      positionId: positionIdOf(repay),
      maxPayoff: payoffCeiling.toString(),
    }, 'Repurchase settled and collateral released to the seller vault balance.');
    if (result?.ok) setRepay(null);
  };
  const activeDebt = sellerPositions.filter((row) => ['ACTIVE', 'DEFAULT_ELIGIBLE'].includes(row.status)).reduce((sum, row) => sum + asBigInt(pick(row, ['principalAmount', 'principal'])), 0n);
  return <div className="v2-workspace">
    <div className="v2-workspace-bar"><div><span className="section-eyebrow">Segregated books</span><h3>V2 seller and lender portfolio</h3></div><span className="v2-custody"><V2Icon name="vault" size={14}/>Vault custody active</span></div>
    <section className="v2-metrics"><article><span>Seller offers</span><strong>{sellerOffers.length}</strong><small>Open or partially filled</small></article><article><span>Seller debt</span><strong>{amount(activeDebt, settlementDecimals, settlementSymbol)}</strong><small>Outstanding principal</small></article><article><span>Lender positions</span><strong>{lenderPositions.filter((row) => row.status === 'ACTIVE').length}</strong><small>Independent fill maturities</small></article></section>
    <section className="card v2-portfolio-card"><nav className="v2-tabs">{tabs.map((item) => <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}<span>{item.rows.length}</span></button>)}</nav>{loading ? <div className="v2-loading">Synchronizing V2 positions…</div> : selected.rows.length ? <div className="table-wrap"><table><thead><tr><th>Position</th><th>Book</th><th>Principal</th><th>Collateral</th><th>Maturity</th><th>Status</th><th/></tr></thead><tbody>{selected.rows.map((row) => {
      const asset = assetFor(assets, pick(row, ['assetAddress', 'asset']));
      const isOffer = pick(row, ['offerId']) !== null && pick(row, ['positionId']) === null;
      const resourceId = isOffer ? offerIdOf(row) : positionIdOf(row);
      const rowIsLender = !isOffer && [pick(row, ['buyer']), pick(row, ['lender'])]
        .some((value) => value?.toLowerCase() === address?.toLowerCase());
      return <tr key={`${isOffer ? 'offer' : 'position'}-${resourceId}`}><td><div className="asset-cell"><span className="asset-monogram">{(asset?.symbol || 'CVA').slice(0,2)}</span><div><strong>{isOffer ? `Offer #${resourceId}` : `Position #${resourceId}`}</strong><CvaSeal asset={asset} compact/></div></div></td><td><span className={`side ${rowIsLender ? 'buyer' : 'seller'}`}>{rowIsLender ? 'Lender' : 'Seller'}</span></td><td className="number">{amount(pick(row, ['principalAmount', 'principal', 'targetPrincipal']), settlementDecimals, settlementSymbol)}</td><td>{amount(pick(row, ['allocatedCollateral', 'collateralAmount', 'collateral', 'totalCollateral']), asset?.decimals ?? 6, asset?.symbol || 'CVA')}</td><td>{dateTime(pick(row, ['maturityAt', 'maturity']))}</td><td><StagePill value={row.status}/></td><td>{lifecycleAction(row, isOffer)}</td></tr>;
    })}</tbody></table></div> : <div className="v2-empty"><V2Icon name="wallet" size={25}/><strong>{address ? `No ${selected.label.toLowerCase()}` : 'Connect a wallet to load V2 books'}</strong><p>Offers and lender fills are intentionally reported as separate institutional books.</p></div>}</section>
    {pendingClaims.length > 0 && <section className="card v2-claims-card"><div className="card-header"><div><h3>Settlement escrow claims</h3><p>Beneficiary-specific proceeds remain segregated until your live Cleanverse eligibility permits withdrawal.</p></div><StagePill value="CLAIMABLE"/></div><div className="table-wrap"><table><thead><tr><th>Claim</th><th>Source</th><th>Remaining</th><th>Beneficiary</th><th/></tr></thead><tbody>{pendingClaims.map((claim) => <tr key={`${pick(claim, ['escrowAddress'], '')}:${pick(claim, ['claimId', 'id'])}`}><td><strong>#{pick(claim, ['claimId', 'id'])}</strong></td><td>{statusTitle(pick(claim, ['claimType', 'sourceType', 'reason'], 'Settlement proceeds'))}</td><td className="number gold-text">{amount(pick(claim, ['remaining', 'remainingAmount']), settlementDecimals, settlementSymbol)}</td><td>{short(pick(claim, ['beneficiary']))}</td><td><button className="table-action" disabled={busy || !address} onClick={() => openClaim(claim)}>Withdraw</button></td></tr>)}</tbody></table></div></section>}
    {claimIntent && <Modal eyebrow={`Escrow claim #${pick(claimIntent, ['claimId', 'id'])}`} title="Withdraw settlement proceeds" onClose={() => setClaimIntent(null)} footer={<><button className="button secondary" onClick={() => setClaimIntent(null)}>Cancel</button><button className="button primary" disabled={busy || !claimAmount} onClick={submitClaim}>{busy ? 'Execution in progress…' : 'Verify & Withdraw'}</button></>}><label className="field"><span>Claim amount</span><div className="input-affix"><input autoFocus inputMode="decimal" value={claimAmount} onChange={(event) => setClaimAmount(event.target.value)}/><b>{settlementSymbol}</b></div></label><dl className="v2-quote"><div><dt>Available</dt><dd>{amount(pick(claimIntent, ['remaining', 'remainingAmount']), settlementDecimals, settlementSymbol)}</dd></div><div><dt>Recipient</dt><dd>{short(address)}</dd></div></dl>{formError && <div className="v2-form-error">{formError}</div>}<p className="v2-disclosure"><V2Icon name="shield" size={13}/>You may withdraw all or part of this claim. The remaining ledger balance stays in escrow and cannot be redirected.</p></Modal>}
    {repay && (() => {
      const maturityReached = asTime(pick(repay, ['maturityAt', 'maturity'])) <= now;
      const canRepay = repay.earlyRepurchaseEnabled !== false || maturityReached;
      const collateralAsset = assetFor(assets, pick(repay, ['assetAddress', 'asset']));
      return <Modal eyebrow={`Position #${positionIdOf(repay)}`} title={maturityReached ? 'Contractual repurchase payoff' : 'Early repurchase payoff'} onClose={() => setRepay(null)} footer={<><button className="button secondary" onClick={() => setRepay(null)}>Close</button><button className="button primary" disabled={busy || !canRepay || !payoffFresh} onClick={submitRepay}>{busy ? 'Execution in progress…' : payoffFresh ? 'Verify & Repurchase' : 'Loading live payoff…'}</button></>}><div className="v2-payoff-head"><span><V2Icon name="clock"/></span><div><strong>{!canRepay ? 'Early repurchase is disabled until maturity' : maturityReached ? 'Contractual payoff is due' : 'ACT/365 accrued payoff'}</strong><small>Opening fees are non-refundable · compensation capped at scheduled interest</small></div></div>{remotePayoffError && <div className="v2-form-error"><span>{remotePayoffError}</span><button type="button" className="table-action" onClick={() => setPayoffAttempt((value) => value + 1)}>Retry payoff</button></div>}<dl className="v2-quote"><div><dt>Principal</dt><dd>{amount(quote.principal, settlementDecimals, settlementSymbol)}</dd></div><div><dt>Contractual compensation</dt><dd>{amount(quote.accrued, settlementDecimals, settlementSymbol)}</dd></div>{quote.defaultInterest > 0n && <div><dt>Default interest</dt><dd>{amount(quote.defaultInterest, settlementDecimals, settlementSymbol)}</dd></div>}<div><dt>Payoff ceiling</dt><dd className="gold-text">{amount(payoffCeiling, settlementDecimals, settlementSymbol)}</dd></div><div><dt>Collateral released</dt><dd>{amount(pick(repay, ['allocatedCollateral', 'collateralAmount', 'collateral']), collateralAsset?.decimals ?? 6, collateralAsset?.symbol || 'CVA')}</dd></div></dl><p className="v2-disclosure"><V2Icon name="shield" size={13}/>The payoff refreshes every 15 seconds. Its ceiling includes five minutes of rate drift; execution above that ceiling reverts safely.</p></Modal>;
    })()}
  </div>;
}

function normalizeBalance(row, asset) {
  const walletValue = pick(row, ['walletBalance', 'externalBalance']);
  return {
    wallet: walletValue === null ? null : asBigInt(walletValue),
    available: asBigInt(pick(row, ['available', 'availableBalance'])),
    reserved: asBigInt(pick(row, ['offerReserved', 'reserved'])),
    locked: asBigInt(pick(row, ['positionLocked', 'locked'])),
    auction: asBigInt(pick(row, ['auctionLocked'], 0)),
    margin: asBigInt(pick(row, ['marginLocked'], 0)),
    decimals: Number(pick(row, ['decimals'], asset?.decimals ?? 6)),
  };
}

export function VaultPage({ balances, assets, address, loading, busy, onAction, entryEnabled = false }) {
  const [intent, setIntent] = useState(null);
  const [quantity, setQuantity] = useState('');
  const [formError, setFormError] = useState('');
  const rows = balances.length ? balances : assets.map((asset) => ({ assetAddress: asset.address, symbol: asset.symbol, decimals: asset.decimals }));
  const submit = async () => {
    try {
      if (intent.mode === 'deposit' && !entryEnabled) throw new Error('New isolated-market custody entry is paused. Available collateral can still be withdrawn.');
      const asset = assetFor(assets, pick(intent.row, ['assetAddress', 'asset'])) || intent.row;
      const rawAmount = parseUnits(quantity, asset.decimals ?? 6);
      if (rawAmount <= 0n) throw new Error('Amount must be greater than zero.');
      setFormError('');
      const result = await onAction(intent.mode, { actor: address, asset: asset.address || pick(intent.row, ['assetAddress', 'asset']), amount: rawAmount.toString() }, intent.mode === 'deposit' ? 'Collateral deposited into your segregated vault balance.' : 'Available collateral withdrawn from the vault.');
      if (result?.ok) setIntent(null);
    } catch (reason) {
      setFormError(reason.message || 'Enter a valid collateral amount.');
    }
  };
  return <div className="page-view"><div className="page-heading"><div><span className="section-eyebrow">Segregated custody</span><h2>Tri-party Collateral Vault</h2><p>Deposit CVA once, then reserve it across institutional repo offers without transferring title to the market contract.</p></div><span className="v2-custody"><V2Icon name="shield" size={14}/>Cleanverse custody perimeter</span></div><div className="v2-vault-note"><V2Icon name="vault" size={20}/><div><strong>Vault accounting is on-chain and non-rehypothecating</strong><p>Only available balances can be withdrawn. Reserved, position, auction and margin collateral remain segregated by their recorded obligation.</p></div></div>{loading ? <div className="card v2-loading">Reconciling on-chain vault balances…</div> : rows.length ? <section className="v2-vault-grid">{rows.map((row) => {
    const asset = assetFor(assets, pick(row, ['assetAddress', 'asset'])) || row;
    const values = normalizeBalance(row, asset);
    const custody = values.available + values.reserved + values.locked + values.auction + values.margin;
    const segments = [values.available, values.reserved, values.locked, values.auction, values.margin];
    const labels = ['Available', 'Offer reserved', 'Position locked', 'Auction locked', 'Margin locked'];
    return <article className="card v2-vault-card" key={asset.address || asset.symbol}><header><div className="asset-cell"><span className="asset-monogram large">{(asset.symbol || 'CVA').slice(0,2)}</span><div><strong>{asset.name || asset.symbol || 'Verified asset'}</strong><CvaSeal asset={asset}/></div></div><StagePill value="CUSTODIED"/></header><div className="v2-vault-total"><span>Total protocol custody</span><strong>{amount(custody, values.decimals, asset.symbol || 'CVA')}</strong><small>{values.wallet === null ? 'External wallet balance checked during preflight' : `Wallet balance: ${amount(values.wallet, values.decimals, asset.symbol || 'CVA')}`}</small></div><div className="v2-allocation-bar">{segments.map((segment, index) => <span key={labels[index]} className={`segment s${index}`} style={{ width: custody > 0n ? `${Number(segment * 10_000n / custody) / 100}%` : `${index === 0 ? 100 : 0}%` }} title={`${labels[index]}: ${amount(segment, values.decimals)}`}/>)}</div><dl className="v2-vault-ledger">{segments.map((segment, index) => <div key={labels[index]}><dt><i className={`s${index}`}/>{labels[index]}</dt><dd>{amount(segment, values.decimals)}</dd></div>)}</dl><footer><button className="button secondary" disabled={!address || busy || values.available === 0n} onClick={() => { setIntent({ mode: 'withdraw', row }); setQuantity(''); setFormError(''); }}>Withdraw available</button><button className="button primary" disabled={!address || busy || !entryEnabled} onClick={() => { setIntent({ mode: 'deposit', row }); setQuantity(''); setFormError(''); }}>{entryEnabled ? 'Deposit collateral' : 'Entry paused'}</button></footer></article>;
  })}</section> : <div className="card v2-empty"><V2Icon name="vault" size={25}/><strong>No approved CVA vaults</strong><p>The environment has no Cleanverse-registered custody vault yet.</p></div>}{intent && <Modal eyebrow="Tri-party custody" title={`${intent.mode === 'deposit' ? 'Deposit' : 'Withdraw'} collateral`} onClose={() => setIntent(null)} footer={<><button className="button secondary" onClick={() => setIntent(null)}>Cancel</button><button className="button primary" disabled={busy || !quantity} onClick={submit}>{busy ? 'Execution in progress…' : `${intent.mode === 'deposit' ? 'Verify & Deposit' : 'Verify & Withdraw'}`}</button></>}><div className="v2-modal-asset"><span className="asset-monogram large">{(pick(intent.row, ['symbol'], assetFor(assets, pick(intent.row, ['assetAddress', 'asset']))?.symbol) || 'CVA').slice(0,2)}</span><div><strong>{pick(intent.row, ['name'], assetFor(assets, pick(intent.row, ['assetAddress', 'asset']))?.name) || 'Cleanverse asset'}</strong><CvaSeal asset={assetFor(assets, pick(intent.row, ['assetAddress', 'asset'])) || intent.row}/></div></div><label className="field"><span>Amount</span><div className="input-affix"><input autoFocus inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)}/><b>{pick(intent.row, ['symbol'], assetFor(assets, pick(intent.row, ['assetAddress', 'asset']))?.symbol) || 'CVA'}</b></div></label>{formError && <div className="v2-form-error">{formError}</div>}<p className="v2-disclosure"><V2Icon name="shield" size={13}/>{intent.mode === 'deposit' ? 'The exact token amount is approved to the registered vault and reconciled by balance delta.' : 'Only unencumbered collateral can leave the custody perimeter. Any unsafe withdrawal reverts.'}</p></Modal>}</div>;
}

function liveAuctionPrice(row, now) {
  const start = asBigInt(pick(row, ['startPrice', 'startPriceAmount']));
  const floor = asBigInt(pick(row, ['floorPrice', 'floorPriceAmount']));
  const started = asTime(pick(row, ['startedAt', 'startsAt'], now));
  const ends = asTime(pick(row, ['endsAt', 'expiryAt'], now));
  if (now <= started || ends <= started) return start;
  if (now >= ends) return floor;
  const elapsed = BigInt(Math.floor((now - started) / 1000));
  const duration = BigInt(Math.max(1, Math.floor((ends - started) / 1000)));
  return start > floor ? start - ((start - floor) * elapsed / duration) : start;
}

export function AuctionsPage({ auctions, assets, address, loading, busy, onAction, settlement = {}, chainClock = null }) {
  const settlementDecimals = Number(settlement.decimals ?? 6);
  const settlementSymbol = settlement.symbol || 'aUSDC';
  const [, setClockTick] = useState(0);
  const [selected, setSelected] = useState(null);
  useEffect(() => { const timer = window.setInterval(() => setClockTick((value) => value + 1), 1000); return () => window.clearInterval(timer); }, []);
  const now = chainNow(chainClock);
  const price = selected ? liveAuctionPrice(selected, now) : 0n;
  const debt = selected ? asBigInt(pick(selected, ['lenderDebt', 'frozenDebt', 'debtAmount'])) : 0n;
  const costs = selected ? ceilDiv(price * asBigInt(pick(selected, ['liquidationFeeBps'], 0)), 10_000n) : 0n;
  const lenderRecovery = price < debt ? price : debt;
  const costRecovery = price > lenderRecovery ? (price - lenderRecovery < costs ? price - lenderRecovery : costs) : 0n;
  const sellerSurplus = price > lenderRecovery + costRecovery ? price - lenderRecovery - costRecovery : 0n;
  const buySelected = async () => {
    if (!selected) return;
    const result = await onAction('buy-auction', {
      actor: address,
      auctionId: auctionIdOf(selected),
      maxPrice: price.toString(),
    }, 'Auction purchased atomically and proceeds distributed by the on-chain waterfall.');
    if (result?.ok) setSelected(null);
  };
  return <div className="page-view"><div className="page-heading"><div><span className="section-eyebrow">Default resolution</span><h2>Dutch Collateral Auctions</h2><p>Permissionless, compliance-gated price discovery with an explicit institutional settlement waterfall.</p></div><span className="v2-live"><i/>Prices update live</span></div>{loading ? <div className="card v2-loading">Loading active liquidation lots…</div> : auctions.length ? <section className="v2-auction-grid">{auctions.map((row) => {
    const asset = assetFor(assets, pick(row, ['assetAddress', 'asset']));
    const current = liveAuctionPrice(row, now);
    const startPrice = asBigInt(pick(row, ['startPrice', 'startPriceAmount']));
    const floorPrice = asBigInt(pick(row, ['floorPrice', 'floorPriceAmount']));
    const priceSpread = startPrice > floorPrice ? startPrice - floorPrice : 0n;
    const priceProgress = priceSpread > 0n && current >= floorPrice
      ? Number((current - floorPrice) * 10_000n / priceSpread) / 100
      : 0;
    const ends = asTime(pick(row, ['endsAt', 'expiryAt']));
    const ended = now > ends;
    const seconds = Math.max(0, Math.ceil((ends - now) / 1000));
    return <article className="card v2-auction-card" key={auctionIdOf(row)}><header><div><span className="section-eyebrow">Auction #{auctionIdOf(row)}</span><h3>{asset?.name || 'Verified RWA collateral'}</h3></div><StagePill value={ended ? 'ENDED' : 'LIVE'}/></header><CvaSeal asset={asset}/><div className="v2-auction-price"><span>Current Dutch price</span><strong>{amount(current, settlementDecimals, settlementSymbol)}</strong><small>{ended ? 'Auction window ended' : `${Math.floor(seconds / 60)}m ${seconds % 60}s remaining`}</small></div><div className="v2-price-track"><i/><span style={{ width: `${Math.max(0, Math.min(100, priceProgress))}%` }}/></div><dl><div><dt>Collateral</dt><dd>{amount(pick(row, ['collateralAmount', 'collateral']), asset?.decimals ?? 6, asset?.symbol || 'CVA')}</dd></div><div><dt>Frozen lender debt</dt><dd>{amount(pick(row, ['lenderDebt', 'frozenDebt', 'debtAmount']), settlementDecimals, settlementSymbol)}</dd></div><div><dt>Closeout valuation</dt><dd className="success-text">Frozen at default</dd></div></dl>{!ended ? <button className="button primary full" disabled={!address || busy} onClick={() => setSelected(row)}>Review & Buy Collateral</button> : <button className="button secondary full" disabled={!address || busy || row.status !== 'OPEN'} onClick={() => onAction('finalize-failed-auction', { actor: address, auctionId: auctionIdOf(row) }, 'Ended auction finalized. The lender collateral-claim fallback is now available.')}>Finalize failed auction</button>}</article>;
  })}</section> : <div className="card v2-empty"><V2Icon name="auction" size={27}/><strong>No collateral is in auction</strong><p>Defaults enter a transparent Dutch auction after the contractual grace deadline.</p></div>}{selected && <Modal eyebrow={`Auction #${auctionIdOf(selected)}`} title="Atomic liquidation settlement" onClose={() => setSelected(null)} footer={<><button className="button secondary" onClick={() => setSelected(null)}>Cancel</button><button className="button primary" disabled={busy} onClick={buySelected}>{busy ? 'Execution in progress…' : `Buy for ${amount(price, settlementDecimals, settlementSymbol)}`}</button></>}><div className="v2-waterfall"><h4>Settlement waterfall</h4><ol><li><span><b>1</b>Lender recovery</span><strong>{amount(lenderRecovery, settlementDecimals, settlementSymbol)}</strong></li><li><span><b>2</b>Liquidation cost</span><strong>{amount(costRecovery, settlementDecimals, settlementSymbol)}</strong></li><li><span><b>3</b>Seller surplus</span><strong>{amount(sellerSurplus, settlementDecimals, settlementSymbol)}</strong></li></ol><div><span>Maximum purchase price</span><strong>{amount(price, settlementDecimals, settlementSymbol)}</strong></div></div><p className="v2-disclosure"><V2Icon name="shield" size={13}/>Your CVI and eligibility to receive this exact CVA are verified before signature and enforced again by the asset transfer hook.</p></Modal>}</div>;
}

const MARGIN_OPERATION_LABELS = Object.freeze({
  DEPOSIT: 'Deposit to margin custody',
  WITHDRAW: 'Withdraw unallocated custody',
  OPEN_ACCOUNT: 'Open netting set',
  ADD_COLLATERAL: 'Add account collateral',
  WITHDRAW_EXCESS: 'Withdraw excess collateral',
  FUND_ACCOUNT: 'Fund lender exposure',
  CLOSE_FUNDING: 'Close further funding',
  REPAY: 'Repay exposure',
  DECLARE_PAYMENT_DEFAULT: 'Declare payment default',
  OPEN_MARGIN_CALL: 'Open margin call',
  CURE: 'Confirm margin-call cure',
  LIQUIDATE: 'Start liquidation',
  BUY_AUCTION: 'Buy margin auction',
  FINALIZE_FAILED_AUCTION: 'Finalize failed auction',
  START_IN_KIND_ORACLE_FALLBACK: 'Start stale-oracle fallback',
  MATERIALIZE_LIQUIDATION_CLAIM: 'Materialize lender proceeds',
  CLAIM_FAILED_COLLATERAL: 'Claim in-kind collateral',
  CLOSE_ACCOUNT: 'Close debt-free account',
});

const MARGIN_ACCOUNT_ACTIONS = new Set(['ADD_COLLATERAL', 'WITHDRAW_EXCESS', 'FUND_ACCOUNT', 'CLOSE_FUNDING', 'OPEN_MARGIN_CALL', 'CURE', 'LIQUIDATE', 'START_IN_KIND_ORACLE_FALLBACK', 'CLOSE_ACCOUNT']);
const MARGIN_EXPOSURE_ACTIONS = new Set(['REPAY', 'DECLARE_PAYMENT_DEFAULT', 'MATERIALIZE_LIQUIDATION_CLAIM', 'CLAIM_FAILED_COLLATERAL']);
const MARGIN_AUCTION_ACTIONS = new Set(['BUY_AUCTION', 'FINALIZE_FAILED_AUCTION']);
const MARGIN_AMOUNT_ACTIONS = new Set(['DEPOSIT', 'WITHDRAW', 'OPEN_ACCOUNT', 'ADD_COLLATERAL', 'WITHDRAW_EXCESS', 'FUND_ACCOUNT']);
const MARGIN_ENTRY_ACTIONS = new Set(['OPEN_ACCOUNT', 'FUND_ACCOUNT']);
const isEvmAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(String(value || ''));
const isUintId = (value) => /^\d+$/.test(String(value || ''));

function optionalAmount(value, decimals, symbol) {
  return value === undefined || value === null ? '—' : amount(value, decimals, symbol);
}

function marginRiskTone(status, ltv, maintenance, liquidation) {
  if (['LIQUIDATING', 'LIQUIDATED', 'AUCTION_FAILED'].includes(status)) return 'danger';
  if (status === 'MARGIN_CALL') return 'warning';
  if (ltv !== null && liquidation > 0 && ltv > liquidation) return 'danger';
  if (ltv !== null && maintenance > 0 && ltv > maintenance) return 'warning';
  return 'healthy';
}

export function MarginPage({ accounts, auctions = [], assets, address, loading, busy, onAction, settlement = {}, deployed = false, entryEnabled = false, readiness = null, durations = [], chainClock = null }) {
  const settlementDecimals = Number(settlement.decimals ?? 6);
  const settlementSymbol = settlement.symbol || 'aUSDC';
  const proof = readiness?.proof || null;
  const proofAssetAddress = proof?.asset || '';
  const marginAsset = assetFor(assets, proofAssetAddress)
    || assetFor(assets, pick(accounts[0], ['assetAddress', 'asset']))
    || null;
  const marginDecimals = Number(marginAsset?.decimals ?? 6);
  const marginSymbol = marginAsset?.symbol || 'CVA';
  const operational = deployed === true && Boolean(address);
  const collateralAmountOperational = operational && Boolean(marginAsset);
  const entryOperational = operational && entryEnabled === true;
  const allowedDurations = durations.filter((value) => Number.isSafeInteger(Number(value)) && Number(value) > 0);
  const [intent, setIntent] = useState(null);
  const [formError, setFormError] = useState('');
  const now = chainNow(chainClock);

  const openIntent = (action, context = {}, manual = false) => {
    setFormError('');
    setIntent({
      action,
      accountId: context.accountId || '',
      exposureId: context.exposureId || '',
      auctionId: context.auctionId || '',
      amount: context.amount || (action === 'FUND_ACCOUNT' ? '1' : ''),
      fundingTarget: context.fundingTarget || '10',
      minimumFunding: context.minimumFunding || '1',
      rate: context.rate || '5.75',
      maxRate: context.maxRate || '8.00',
      duration: String(context.duration || allowedDurations[0] || ''),
      fundingExpiryMinutes: context.fundingExpiryMinutes || '60',
      permittedLender: context.permittedLender || '',
      maxPrice: context.maxPrice || '',
      recipient: address || '',
      useEscrow: true,
      manual,
    });
  };

  const changeIntent = (key, value) => setIntent((current) => ({ ...current, [key]: value }));
  const requireOperational = (action) => {
    if (!deployed) throw new Error('The verified MarginEngine deployment is unavailable.');
    if (!address) throw new Error('Connect a wallet to continue.');
    if (MARGIN_AMOUNT_ACTIONS.has(action) && action !== 'FUND_ACCOUNT' && !marginAsset) {
      throw new Error('The deployed MarginEngine asset metadata is unavailable for this amount-based operation.');
    }
  };

  const submitIntent = async () => {
    try {
      const action = intent?.action;
      requireOperational(action);
      if (!MARGIN_OPERATION_LABELS[action]) throw new Error('Select a supported margin operation.');
      if (MARGIN_ENTRY_ACTIONS.has(action) && !entryEnabled) throw new Error('New margin entry is paused. Exit and risk-reduction actions remain available.');
      const body = { actor: address, action };
      if (MARGIN_ACCOUNT_ACTIONS.has(action)) {
        if (!isUintId(intent.accountId)) throw new Error('Enter a valid margin account ID.');
        body.accountId = intent.accountId;
      }
      if (MARGIN_EXPOSURE_ACTIONS.has(action)) {
        if (!isUintId(intent.exposureId)) throw new Error('Enter a valid lender exposure ID.');
        body.exposureId = intent.exposureId;
      }
      if (MARGIN_AUCTION_ACTIONS.has(action)) {
        if (!isUintId(intent.auctionId)) throw new Error('Enter a valid margin auction ID.');
        body.auctionId = intent.auctionId;
      }
      if (MARGIN_AMOUNT_ACTIONS.has(action)) {
        const decimals = action === 'FUND_ACCOUNT' ? settlementDecimals : marginDecimals;
        const rawAmount = parseUnits(intent.amount, decimals);
        if (rawAmount <= 0n) throw new Error('Amount must be greater than zero.');
        body.amount = rawAmount.toString();
      }
      if (action === 'OPEN_ACCOUNT') {
        const fundingTarget = parseUnits(intent.fundingTarget, settlementDecimals);
        const minimumFunding = parseUnits(intent.minimumFunding, settlementDecimals);
        const maxAnnualRateBps = Math.round(Number(intent.maxRate) * 100);
        const durationSeconds = Number(intent.duration);
        const expiryMinutes = Number(intent.fundingExpiryMinutes);
        if (fundingTarget <= 0n || minimumFunding <= 0n || minimumFunding > fundingTarget) throw new Error('Funding target and minimum funding must be positive, and minimum funding cannot exceed the target.');
        if (!Number.isSafeInteger(maxAnnualRateBps) || maxAnnualRateBps < 0 || maxAnnualRateBps > 100_000) throw new Error('Enter a maximum rate between 0% and 1,000%.');
        if (!allowedDurations.includes(durationSeconds)) throw new Error('Select an allowed on-chain funding term.');
        if (!Number.isSafeInteger(expiryMinutes) || expiryMinutes < 1 || expiryMinutes > 43_200) throw new Error('Funding validity must be between 1 minute and 30 days.');
        if (intent.permittedLender && !isEvmAddress(intent.permittedLender)) throw new Error('Enter a valid permitted lender or leave it public.');
        Object.assign(body, {
          asset: marginAsset.address,
          fundingTarget: fundingTarget.toString(),
          minimumFunding: minimumFunding.toString(),
          maxAnnualRateBps,
          durationSeconds,
          fundingExpiry: Math.floor(now / 1000) + expiryMinutes * 60,
          permittedLender: intent.permittedLender || null,
        });
      }
      if (action === 'FUND_ACCOUNT') {
        const annualRateBps = Math.round(Number(intent.rate) * 100);
        if (!Number.isSafeInteger(annualRateBps) || annualRateBps < 0 || annualRateBps > 100_000) throw new Error('Enter a rate between 0% and 1,000%.');
        body.annualRateBps = annualRateBps;
      }
      if (action === 'REPAY') body.useEscrow = Boolean(intent.useEscrow);
      if (action === 'BUY_AUCTION') {
        const maxPrice = parseUnits(intent.maxPrice, settlementDecimals);
        if (maxPrice <= 0n) throw new Error('Set a positive maximum auction price.');
        body.maxPrice = maxPrice.toString();
      }
      if (['WITHDRAW', 'WITHDRAW_EXCESS', 'CLAIM_FAILED_COLLATERAL'].includes(action)) {
        const recipient = intent.recipient || address;
        if (!isEvmAddress(recipient)) throw new Error('Enter a valid recipient address.');
        body.recipient = recipient;
      }
      setFormError('');
      const outcome = await onAction('margin-action', body, `${MARGIN_OPERATION_LABELS[action]} confirmed and submitted for finalized indexing.`);
      if (outcome?.ok) setIntent(null);
    } catch (reason) {
      setFormError(reason.message || 'Review the operation fields and try again.');
    }
  };

  const reference = accounts[0] || null;
  const riskLabel = (key) => {
    const value = Number(pick(reference, [key], 0));
    return value > 0 ? percent(value) : 'Per-account snapshot';
  };

  return <div className="page-view">
    <div className="page-heading">
      <div><span className="section-eyebrow">Master netting sets</span><h2>Shared Collateral & Margin</h2><p>One immutable Cleanverse CVA per engine, shared across lender exposures without rehypothecation.</p></div>
      <div className="v2-heading-actions"><span className="v2-custody"><V2Icon name="margin" size={14}/>Pari-passu closeout</span><button className="button secondary" disabled={!entryOperational || !marginAsset || busy} onClick={() => openIntent('OPEN_ACCOUNT')}>{deployed ? entryEnabled ? 'Author funding mandate' : 'New entry paused' : 'MarginEngine pending'}</button></div>
    </div>

    {!deployed && <div className="v2-feature-gate"><V2Icon name="info" size={15}/><div><strong>Verified MarginEngine deployment unavailable</strong><small>Mutation controls remain disabled until the deployment registry proves the engine and its custody modules.</small></div></div>}
    {deployed && !entryEnabled && <div className="v2-feature-gate"><V2Icon name="info" size={15}/><div><strong>New margin entry is paused</strong><small>Opening and funding are disabled. Deposits, withdrawals, repayment, cure, closeout and claims remain available for exit safety.</small></div></div>}
    {deployed && !marginAsset && <div className="v2-feature-gate"><V2Icon name="info" size={15}/><div><strong>Margin asset metadata unavailable</strong><small>CVA amount entry is disabled, but repayment, cure, liquidation, auction finalization, claim materialization and account close remain available.</small></div></div>}

    <section className="card v2-margin-operations">
      <div><span className="section-eyebrow">Segregated margin custody</span><strong>{marginAsset?.name || 'Configured MarginEngine CVA'}</strong><small>{proof?.vault ? `Vault ${short(proof.vault)}` : 'Vault proof unavailable'}</small></div>
      <CvaSeal asset={marginAsset}/>
      <div className="v2-margin-operation-buttons">
        <button className="button secondary" disabled={!collateralAmountOperational || busy} onClick={() => openIntent('DEPOSIT')}>Deposit {marginSymbol}</button>
        <button className="button secondary" disabled={!collateralAmountOperational || busy} onClick={() => openIntent('WITHDRAW')}>Withdraw unallocated</button>
        <button className="button primary" disabled={!operational || busy} onClick={() => openIntent(entryEnabled ? 'FUND_ACCOUNT' : 'REPAY', {}, true)}>Lender & closeout console</button>
      </div>
    </section>

    <section className="v2-risk-legend"><div><i className="initial"/><span>Initial {riskLabel('initialLtvBps')}</span></div><div><i className="maintenance"/><span>Maintenance {riskLabel('maintenanceLtvBps')}</span></div><div><i className="liquidation"/><span>Liquidation {riskLabel('liquidationLtvBps')}</span></div><p>Signed valuation · stale data fails closed</p></section>

    {auctions.length > 0 && <section className="v2-margin-auctions"><div className="v2-section-heading"><div><span className="section-eyebrow">Shared-collateral closeout</span><h3>Margin liquidation auctions</h3></div><small>Complete collateral lots · escrowed waterfall</small></div><div className="v2-auction-grid">{auctions.map((auction) => {
      const auctionId = auctionIdOf(auction);
      const currentPrice = liveAuctionPrice(auction, now);
      const endsAt = asTime(pick(auction, ['endsAt', 'expiryAt']));
      const ended = endsAt > 0 && now > endsAt;
      const sellerIsMe = pick(auction, ['seller'], '').toLowerCase() === address?.toLowerCase();
      return <article className="card v2-auction-card" key={`margin-${auctionId}`}><header><div><span className="section-eyebrow">Margin auction #{auctionId}</span><h3>Netting set #{pick(auction, ['marginAccountId'], '—')}</h3></div><StagePill value={ended ? 'ENDED' : auction.status || 'OPEN'}/></header><CvaSeal asset={marginAsset}/><div className="v2-auction-price"><span>Current maximum price</span><strong>{amount(currentPrice, settlementDecimals, settlementSymbol)}</strong><small>{endsAt > 0 ? `${ended ? 'Ended' : 'Ends'} ${dateTime(endsAt)}` : 'Finalized auction time unavailable'}</small></div><dl><div><dt>Collateral lot</dt><dd>{amount(auction.collateralAmount, marginDecimals, marginSymbol)}</dd></div><div><dt>Frozen lender pool</dt><dd>{amount(auction.frozenDebt, settlementDecimals, settlementSymbol)}</dd></div></dl>{ended ? <button className="button secondary full" disabled={!operational || busy} onClick={() => openIntent('FINALIZE_FAILED_AUCTION', { auctionId })}>Finalize failed auction</button> : <button className="button primary full" disabled={!operational || busy || sellerIsMe || currentPrice <= 0n} onClick={() => openIntent('BUY_AUCTION', { auctionId, maxPrice: formatUnits(currentPrice, settlementDecimals, settlementDecimals) })}>{sellerIsMe ? 'Seller cannot self-buy' : 'Review & buy lot'}</button>}</article>;
    })}</div></section>}

    {loading ? <div className="card v2-loading">Calculating finalized netting-set health…</div> : accounts.length ? <section className="v2-margin-grid">{accounts.map((row) => {
      const asset = assetFor(assets, pick(row, ['assetAddress', 'asset'])) || marginAsset;
      const status = String(pick(row, ['status'], 'UNKNOWN'));
      const directLtv = pick(row, ['ltvBps', 'currentLtvBps']);
      const ltv = directLtv === null ? null : Number(directLtv);
      const maintenance = Number(pick(row, ['maintenanceLtvBps'], 0));
      const liquidation = Number(pick(row, ['liquidationLtvBps'], 0));
      const tone = marginRiskTone(status, ltv, maintenance, liquidation);
      const exposures = Array.isArray(pick(row, ['exposures', 'positions'], [])) ? pick(row, ['exposures', 'positions'], []) : [];
      const calls = Array.isArray(row.marginCalls) ? row.marginCalls : [];
      const activeCall = calls.find((call) => call.status === 'OPEN') || null;
      const callDeadline = asTime(activeCall?.cureDeadline || row.marginCallDeadline);
      const seller = pick(row, ['owner', 'seller'], '');
      const mine = seller.toLowerCase() === address?.toLowerCase();
      const debt = asBigInt(pick(row, ['totalDebt', 'totalFaceDebt', 'liabilities']));
      const accountId = accountIdOf(row);
      const auctionId = String(pick(row, ['auctionId'], ''));
      const accountAuction = auctions.find((item) => auctionIdOf(item) === auctionId);
      const accountAuctionEndsAt = asTime(pick(accountAuction, ['endsAt', 'expiryAt']));
      const accountAuctionEnded = accountAuctionEndsAt > 0 && now > accountAuctionEndsAt;
      const fundingTarget = asBigInt(row.fundingTarget);
      const totalFunded = asBigInt(row.totalFunded);
      const remainingFunding = fundingTarget > totalFunded ? fundingTarget - totalFunded : 0n;
      const minimumFunding = asBigInt(row.minimumFunding);
      const fundingExpiry = asTime(row.fundingExpiry);
      const fundingClosed = row.fundingClosed === true;
      const permittedLender = pick(row, ['permittedLender'], '');
      const lenderPermitted = !permittedLender || permittedLender.toLowerCase() === ZERO_ADDRESS || permittedLender.toLowerCase() === address?.toLowerCase();
      const canFund = entryEnabled && !mine && status === 'HEALTHY' && !fundingClosed && remainingFunding > 0n
        && (fundingExpiry === 0 || now <= fundingExpiry) && lenderPermitted;
      const suggestedFunding = remainingFunding < minimumFunding ? remainingFunding : minimumFunding;
      const canOpenCall = status === 'HEALTHY' && ltv !== null && maintenance > 0 && ltv > maintenance;
      const canLiquidate = ['HEALTHY', 'MARGIN_CALL'].includes(status) && (row.paymentDefaultDeclared === true || (callDeadline > 0 && now > callDeadline) || (ltv !== null && liquidation > 0 && ltv > liquidation));
      const fallbackAt = asTime(row.defaultDeclaredAt) + Number(row.staleOracleFallbackDelaySeconds || 0) * 1000;
      const canTryOracleFallback = row.paymentDefaultDeclared === true && fallbackAt > 0 && now > fallbackAt && ['HEALTHY', 'MARGIN_CALL'].includes(status);
      return <article className="card v2-margin-card" key={accountId}>
        <header><div><span className="section-eyebrow">Netting set #{accountId}</span><h3>{asset?.name || 'Shared CVA collateral'}</h3><CvaSeal asset={asset} compact/></div><StagePill value={status}/></header>
        {tone !== 'healthy' && <div className={`v2-margin-call ${tone}`}><V2Icon name="clock" size={15}/><div><strong>{status === 'LIQUIDATING' ? `Auction #${auctionId || '—'} in progress` : tone === 'danger' ? 'Closeout state requires attention' : 'Margin call is active'}</strong><small>{callDeadline > 0 && status === 'MARGIN_CALL' ? `Cure deadline ${dateTime(callDeadline)}` : 'All lifecycle transitions are rechecked on-chain before signature.'}</small></div></div>}
        <div className="v2-health"><div className="v2-health-ring" style={{ '--ltv': ltv === null ? 0 : Math.min(100, ltv / 100), '--health-color': tone === 'healthy' ? '#10B981' : tone === 'warning' ? '#D4AF37' : '#f87171' }}><span><strong>{ltv === null ? '—' : `${(ltv / 100).toFixed(2)}%`}</strong><small>Finalized LTV</small></span></div><dl><div><dt>Signed collateral value</dt><dd>{optionalAmount(row.collateralValue, settlementDecimals, settlementSymbol)}</dd></div><div><dt>Face liabilities</dt><dd>{amount(debt, settlementDecimals, settlementSymbol)}</dd></div><div><dt>Funding mandate</dt><dd>{amount(totalFunded, settlementDecimals, settlementSymbol)} / {amount(fundingTarget, settlementDecimals, settlementSymbol)}</dd></div><div><dt>Maximum rate</dt><dd>{percent(row.maxAnnualRateBps)}</dd></div><div><dt>Funding expiry</dt><dd>{fundingExpiry ? dateTime(fundingExpiry) : '—'}</dd></div><div><dt>Locked collateral</dt><dd>{amount(row.collateralAmount, asset?.decimals ?? marginDecimals, asset?.symbol || marginSymbol)}</dd></div><div><dt>Active exposures</dt><dd>{row.activeExposureCount ?? exposures.filter((item) => item.status === 'ACTIVE').length}</dd></div></dl></div>
        {exposures.length > 0 && <div className="v2-exposures"><span>Lender exposures</span>{exposures.map((exposure) => {
          const exposureId = exposureIdOf(exposure);
          const lender = pick(exposure, ['lender', 'buyer'], '');
          const lenderIsMe = lender.toLowerCase() === address?.toLowerCase();
          const exposureStatus = String(exposure.status || 'UNKNOWN');
          return <div className="v2-exposure-row" key={exposureId}><strong>#{exposureId} · {short(lender)}</strong><span>{amount(pick(exposure, ['faceDebt', 'accruedDebt', 'principal']), settlementDecimals, settlementSymbol)}</span><small>{exposureStatus} · {dateTime(pick(exposure, ['maturityAt', 'maturity']))}</small><span className="v2-exposure-actions">{mine && exposureStatus === 'ACTIVE' && <button disabled={!operational || busy} onClick={() => openIntent('REPAY', { exposureId })}>Repay</button>}{status === 'LIQUIDATED' && exposureStatus === 'ACTIVE' && <button disabled={!operational || busy} onClick={() => openIntent('MATERIALIZE_LIQUIDATION_CLAIM', { exposureId })}>Materialize</button>}{status === 'AUCTION_FAILED' && exposureStatus === 'ACTIVE' && lenderIsMe && <button disabled={!operational || busy} onClick={() => openIntent('CLAIM_FAILED_COLLATERAL', { exposureId })}>Claim CVA</button>}</span></div>;
        })}</div>}
        <footer className="v2-margin-actions">
          {canFund && <button className="button primary" disabled={!operational || busy} onClick={() => openIntent('FUND_ACCOUNT', { accountId, amount: formatUnits(suggestedFunding, settlementDecimals, settlementDecimals), rate: String(Math.min(5.75, Number(row.maxAnnualRateBps || 0) / 100 || 5.75)) })}>Fund mandate</button>}
          {mine && status === 'HEALTHY' && !fundingClosed && <button className="button secondary" disabled={!operational || busy} onClick={() => openIntent('CLOSE_FUNDING', { accountId })}>Close funding</button>}
          {mine && ['HEALTHY', 'MARGIN_CALL'].includes(status) && <button className="button secondary" disabled={!operational || busy} onClick={() => openIntent('ADD_COLLATERAL', { accountId })}>Add collateral</button>}
          {mine && status === 'HEALTHY' && <button className="button secondary" disabled={!operational || busy} onClick={() => openIntent('WITHDRAW_EXCESS', { accountId })}>Withdraw excess</button>}
          {canOpenCall && <button className="button secondary" disabled={!operational || busy} onClick={() => openIntent('OPEN_MARGIN_CALL', { accountId })}>Open margin call</button>}
          {status === 'MARGIN_CALL' && <button className="button secondary" disabled={!operational || busy} onClick={() => openIntent('CURE', { accountId })}>Confirm cure</button>}
          {canLiquidate && <button className="button primary" disabled={!operational || busy} onClick={() => openIntent('LIQUIDATE', { accountId })}>Start liquidation</button>}
          {canTryOracleFallback && <button className="button primary" disabled={!operational || busy} onClick={() => openIntent('START_IN_KIND_ORACLE_FALLBACK', { accountId })}>Oracle fallback</button>}
          {status === 'LIQUIDATING' && auctionId && accountAuctionEnded && <button className="button secondary" disabled={!operational || busy} onClick={() => openIntent('FINALIZE_FAILED_AUCTION', { auctionId })}>Finalize ended auction</button>}
          {mine && status === 'HEALTHY' && debt === 0n && <button className="button secondary" disabled={!operational || busy} onClick={() => openIntent('CLOSE_ACCOUNT', { accountId })}>Close account</button>}
        </footer>
      </article>;
    })}</section> : <div className="card v2-empty"><V2Icon name="margin" size={27}/><strong>No margin netting sets for this wallet</strong><p>Seller-authored funding mandates and lender exposures involving this wallet appear here after finalized indexing.</p><div className="v2-empty-actions"><button className="button secondary" disabled={!collateralAmountOperational || busy} onClick={() => openIntent('DEPOSIT')}>1. Deposit {marginSymbol}</button><button className="button primary" disabled={!entryOperational || !marginAsset || busy} onClick={() => openIntent('OPEN_ACCOUNT')}>2. Author funding mandate</button></div></div>}

    {intent && <Modal eyebrow="MarginEngine V2" title={MARGIN_OPERATION_LABELS[intent.action]} onClose={() => { setIntent(null); setFormError(''); }} footer={<><button className="button secondary" onClick={() => setIntent(null)}>Cancel</button><button className="button primary" disabled={!operational || busy} onClick={submitIntent}>{busy ? 'Execution in progress…' : 'Run verified preflight'}</button></>}>
      {intent.manual && <label className="field"><span>Operation</span><select className="plain-input" value={intent.action} onChange={(event) => changeIntent('action', event.target.value)}>{Object.entries(MARGIN_OPERATION_LABELS).map(([value, label]) => <option key={value} value={value} disabled={MARGIN_ENTRY_ACTIONS.has(value) && !entryEnabled}>{label}{MARGIN_ENTRY_ACTIONS.has(value) && !entryEnabled ? ' (paused)' : ''}</option>)}</select></label>}
      {MARGIN_ACCOUNT_ACTIONS.has(intent.action) && <label className="field"><span>Margin account ID</span><input className="plain-input" inputMode="numeric" value={intent.accountId} onChange={(event) => changeIntent('accountId', event.target.value.trim())} placeholder="e.g. 1"/></label>}
      {MARGIN_EXPOSURE_ACTIONS.has(intent.action) && <label className="field"><span>Lender exposure ID</span><input className="plain-input" inputMode="numeric" value={intent.exposureId} onChange={(event) => changeIntent('exposureId', event.target.value.trim())} placeholder="e.g. 1"/></label>}
      {MARGIN_AUCTION_ACTIONS.has(intent.action) && <label className="field"><span>Margin auction ID</span><input className="plain-input" inputMode="numeric" value={intent.auctionId} onChange={(event) => changeIntent('auctionId', event.target.value.trim())} placeholder="e.g. 1"/></label>}
      {MARGIN_AMOUNT_ACTIONS.has(intent.action) && <label className="field"><span>{intent.action === 'FUND_ACCOUNT' ? 'Lender principal' : intent.action === 'OPEN_ACCOUNT' ? 'Collateral reserved from available custody' : 'Amount'}</span><div className="input-affix"><input inputMode="decimal" value={intent.amount} onChange={(event) => changeIntent('amount', event.target.value)}/><b>{intent.action === 'FUND_ACCOUNT' ? settlementSymbol : marginSymbol}</b></div></label>}
      {intent.action === 'OPEN_ACCOUNT' && <><div className="v2-field-grid"><label className="field"><span>Funding target</span><div className="input-affix"><input inputMode="decimal" value={intent.fundingTarget} onChange={(event) => changeIntent('fundingTarget', event.target.value)}/><b>{settlementSymbol}</b></div></label><label className="field"><span>Minimum lender fill</span><div className="input-affix"><input inputMode="decimal" value={intent.minimumFunding} onChange={(event) => changeIntent('minimumFunding', event.target.value)}/><b>{settlementSymbol}</b></div></label></div><div className="v2-field-grid"><label className="field"><span>Maximum annual rate</span><div className="input-affix"><input inputMode="decimal" value={intent.maxRate} onChange={(event) => changeIntent('maxRate', event.target.value)}/><b>%</b></div></label><label className="field"><span>Exposure term</span><select className="plain-input" value={intent.duration} onChange={(event) => changeIntent('duration', event.target.value)}>{allowedDurations.map((value) => <option key={value} value={value}>{durationLabel(value)}</option>)}</select></label></div><div className="v2-field-grid"><label className="field"><span>Funding window</span><div className="input-affix"><input inputMode="numeric" value={intent.fundingExpiryMinutes} onChange={(event) => changeIntent('fundingExpiryMinutes', event.target.value)}/><b>minutes</b></div></label><label className="field"><span>Permitted lender (optional)</span><input className="plain-input" value={intent.permittedLender} onChange={(event) => changeIntent('permittedLender', event.target.value.trim())} placeholder="0x… or public"/></label></div></>}
      {intent.action === 'FUND_ACCOUNT' && <label className="field"><span>Annual repo rate (within seller mandate)</span><div className="input-affix"><input inputMode="decimal" value={intent.rate} onChange={(event) => changeIntent('rate', event.target.value)}/><b>%</b></div></label>}
      {intent.action === 'BUY_AUCTION' && <label className="field"><span>Maximum purchase price</span><div className="input-affix"><input inputMode="decimal" value={intent.maxPrice} onChange={(event) => changeIntent('maxPrice', event.target.value)}/><b>{settlementSymbol}</b></div></label>}
      {['WITHDRAW', 'WITHDRAW_EXCESS', 'CLAIM_FAILED_COLLATERAL'].includes(intent.action) && <label className="field"><span>Compliant recipient</span><input className="plain-input" value={intent.recipient} onChange={(event) => changeIntent('recipient', event.target.value.trim())}/></label>}
      {intent.action === 'REPAY' && <label className="v2-checkbox"><input type="checkbox" checked={intent.useEscrow} onChange={(event) => changeIntent('useEscrow', event.target.checked)}/><span><strong>Force settlement escrow</strong><small>Recommended. The lender receives a pull claim even if direct receipt is currently blocked.</small></span></label>}
      {intent.action === 'OPEN_ACCOUNT' && <p className="v2-disclosure"><V2Icon name="info" size={13}/>The seller signs the collateral reservation, total funding target, minimum fill, maximum lender rate, term, expiry and optional lender allowlist as one immutable mandate.</p>}
      {intent.action === 'ADD_COLLATERAL' && <p className="v2-disclosure"><V2Icon name="info" size={13}/>This moves existing unallocated margin-vault balance into the account. Deposit custody first if needed.</p>}
      {intent.action === 'FUND_ACCOUNT' && <p className="v2-disclosure"><V2Icon name="shield" size={13}/>Funding cannot exceed the seller's remaining target, minimum fill, maximum rate, permitted-lender or funding-expiry mandate. Live valuation, exact fee and CVI are rechecked.</p>}
      {intent.action === 'CLOSE_FUNDING' && <p className="v2-disclosure"><V2Icon name="shield" size={13}/>Closing funding is risk-reducing and permanent for this netting set. Existing lender exposures remain repayable and closeable.</p>}
      {intent.action === 'MATERIALIZE_LIQUIDATION_CLAIM' && <p className="v2-disclosure"><V2Icon name="shield" size={13}/>This permissionless step converts the lender's exact pro-rata waterfall allocation into a SettlementEscrow pull claim.</p>}
      {intent.action === 'CLAIM_FAILED_COLLATERAL' && <p className="v2-disclosure"><V2Icon name="shield" size={13}/>Only the recorded lender can receive its pro-rata CVA. Cleanverse eligibility is enforced for the recipient.</p>}
      {formError && <div className="v2-form-error">{formError}</div>}
    </Modal>}
  </div>;
}
