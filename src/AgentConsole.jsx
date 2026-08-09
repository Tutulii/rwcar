import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCreateWallet, useSigners, useSignTypedData, useWallets } from '@privy-io/react-auth';
import { apiRequest, API_URL } from './lib/api.js';
import { RWCAR_AGENT_MANIFEST } from './config/rwcar-agent-manifest.js';

const SIGNER_ID = import.meta.env.VITE_PRIVY_AGENT_SIGNER_ID || '';
const POLICY_ID = import.meta.env.VITE_PRIVY_AGENT_POLICY_ID || '';

const ACTIONS = [
  ['VAULT_DEPOSIT', 'Vault deposit'],
  ['VAULT_WITHDRAW', 'Vault withdrawal'],
  ['CREATE_OFFER', 'Create offer'],
  ['FILL_OFFER', 'Fill offer'],
  ['CANCEL_OFFER', 'Cancel offer'],
  ['FINALIZE_OFFER_EXPIRY', 'Finalize expiry'],
  ['REPAY_POSITION', 'Repay position'],
  ['START_AUCTION', 'Start auction'],
  ['CLAIM_COLLATERAL', 'Claim collateral'],
  ['CLAIM_ORACLE_FALLBACK', 'Oracle fallback claim'],
  ['BUY_AUCTION', 'Buy at auction'],
  ['FINALIZE_FAILED_AUCTION', 'Finalize failed auction'],
  ['CLAIM_SETTLEMENT', 'Claim settlement'],
  ['MARGIN_ACTION', 'Margin actions'],
];

const SCOPES = [
  ['protocol:read', 'Read protocol'],
  ['vault:write', 'Vault'],
  ['offers:write', 'Offers'],
  ['positions:write', 'Positions'],
  ['auctions:write', 'Auctions'],
  ['claims:write', 'Claims'],
  ['margin:write', 'Margin'],
  ['intents:execute', 'Execute'],
];

const DEFAULT_ACTIONS = ACTIONS
  .map(([value]) => value)
  .filter((value) => !['START_AUCTION', 'BUY_AUCTION', 'FINALIZE_FAILED_AUCTION', 'MARGIN_ACTION'].includes(value));
const DEFAULT_SCOPES = ['protocol:read'];

const short = (value) => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : 'Not assigned';
const dateTime = (value) => value ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const formatMon = (value) => {
  if (value === null || value === undefined) return 'Unavailable';
  const wei = BigInt(value);
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 5).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} MON`;
};

function toBaseUnits(value, decimals = 6) {
  const normalized = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error('Notional limits must be positive decimal numbers.');
  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) throw new Error(`Use no more than ${decimals} decimal places.`);
  return (BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals))).toString();
}

function normalizeAddresses(value, label) {
  const rows = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const row of rows) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(row)) throw new Error(`${label} contains an invalid address.`);
  }
  return [...new Set(rows.map((row) => row.toLowerCase()))];
}

function AgentState({ value }) {
  const tone = value === 'ACTIVE' || value === 'COMPLETED' || value === 'APPROVED'
    ? 'active'
    : value === 'PAUSED' || value === 'APPROVAL_REQUIRED' || value?.startsWith('PENDING_')
      ? 'pending'
      : value === 'REVOKED' || value === 'DENIED' || value === 'REJECTED' || value === 'FAILED' || value === 'REVERTED'
        ? 'danger'
        : 'neutral';
  return <span className={`agent-state ${tone}`}><i/>{String(value || 'UNKNOWN').replaceAll('_', ' ')}</span>;
}

function SetupStep({ number, title, complete, detail }) {
  return <div className={`agent-setup-step ${complete ? 'complete' : ''}`}>
    <span>{complete ? '✓' : number}</span>
    <div><strong>{title}</strong><small>{detail}</small></div>
  </div>;
}

function ToggleGrid({ rows, selected, onChange }) {
  return <div className="agent-toggle-grid">{rows.map(([value, label]) => <label key={value} className={selected.includes(value) ? 'selected' : ''}>
    <input type="checkbox" checked={selected.includes(value)} onChange={() => onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value])}/>
    <span>{label}</span>
  </label>)}</div>;
}

export default function AgentConsole({ authenticated, adminAddress, login, getAccessToken, assets = [], durations = [] }) {
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const { addSigners } = useSigners();
  const { signTypedData } = useSignTypedData();
  const [institution, setInstitution] = useState(null);
  const [agents, setAgents] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('RWCAR Treasury Agent');
  const [credentialLabel, setCredentialLabel] = useState('Primary MCP credential');
  const [credentialScopes, setCredentialScopes] = useState(DEFAULT_SCOPES);
  const [credentialReveal, setCredentialReveal] = useState(null);
  const [selectedActions, setSelectedActions] = useState(DEFAULT_ACTIONS);
  const [selectedAssets, setSelectedAssets] = useState([]);
  const [manualAsset, setManualAsset] = useState('');
  const [maxPerTransaction, setMaxPerTransaction] = useState('1');
  const [maxDailyNotional, setMaxDailyNotional] = useState('5');
  const [autoExecuteUpTo, setAutoExecuteUpTo] = useState('0.10');
  const [minRate, setMinRate] = useState('0');
  const [maxRate, setMaxRate] = useState('20');
  const [minDuration, setMinDuration] = useState(String(durations[0] || 300));
  const [maxDuration, setMaxDuration] = useState(String(durations.at(-1) || 2_592_000));
  const [mandateDays, setMandateDays] = useState('7');
  const [counterparties, setCounterparties] = useState('');
  const [recipients, setRecipients] = useState('');

  const embeddedWallets = useMemo(
    () => wallets.filter((wallet) => wallet.walletClientType === 'privy' || wallet.walletClientType === 'privy-v2'),
    [wallets],
  );
  const institutionAdminAddress = institution?.adminWallet || adminAddress || '';
  const institutionAdminWallet = useMemo(
    () => wallets.find((wallet) => wallet.address?.toLowerCase() === institutionAdminAddress.toLowerCase()),
    [institutionAdminAddress, wallets],
  );

  const requireInstitutionAdminWallet = () => {
    if (!institutionAdminAddress) throw new Error('Connect the institution administrator wallet first.');
    if (!institutionAdminWallet) {
      throw new Error(`Reconnect institution administrator wallet ${short(institutionAdminAddress)} before signing.`);
    }
    return institutionAdminWallet.address;
  };

  useEffect(() => {
    if (selectedAssets.length || !assets.length) return;
    setSelectedAssets([assets[0].address]);
  }, [assets, selectedAssets.length]);

  const adminRequest = useCallback(async (path, options = {}) => {
    const token = await getAccessToken();
    if (!token) throw new Error('Your Privy session expired. Reconnect the administrator wallet.');
    return apiRequest(path, { ...options, token });
  }, [getAccessToken]);

  const loadDetail = useCallback(async (agentId, quiet = false) => {
    if (!agentId) return;
    if (!quiet) setLoading(true);
    try {
      const next = await adminRequest(`/v2/agents/${agentId}`);
      setDetail(next);
      setError('');
    } catch (reason) {
      if (!quiet) setError(reason.message || 'Unable to load the agent record.');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [adminRequest]);

  const loadAgents = useCallback(async (preferredId = '') => {
    if (!authenticated) return;
    setLoading(true);
    try {
      const result = await adminRequest('/v2/agents');
      const rows = result.agents || [];
      const nextId = preferredId || selectedId || rows[0]?.id || '';
      setInstitution(result.institution || null);
      setAgents(rows);
      setSelectedId(nextId);
      setError('');
      if (nextId) await loadDetail(nextId, true);
      else setDetail(null);
    } catch (reason) {
      setError(reason.message || 'The agent platform is unavailable.');
    } finally {
      setLoading(false);
    }
  }, [adminRequest, authenticated, loadDetail, selectedId]);

  useEffect(() => { if (authenticated) void loadAgents(); }, [authenticated]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!authenticated || !selectedId) return undefined;
    const timer = window.setInterval(() => void loadDetail(selectedId, true), 10_000);
    return () => window.clearInterval(timer);
  }, [authenticated, loadDetail, selectedId]);

  const run = async (label, task) => {
    setWorking(label);
    setError('');
    setNotice('');
    try {
      const result = await task();
      await loadAgents(result?.agentId || selectedId);
      return result;
    } catch (reason) {
      setError(`${reason.message || 'Operation failed'}${reason.correlationId ? ` · ${reason.correlationId}` : ''}`);
      return null;
    } finally {
      setWorking('');
    }
  };

  const createAgentRecord = () => run('create-agent', async () => {
    const administrator = requireInstitutionAdminWallet();
    const agent = await adminRequest('/v2/agents', { body: { name: name.trim(), adminWallet: administrator } });
    setSelectedId(agent.id);
    setNotice('Agent record created. Create its dedicated Privy wallet next.');
    return { agentId: agent.id };
  });

  const bindAgentWallet = async (agent, wallet, attachSigner = false) => {
    if (!wallet?.id) throw new Error('Privy did not return a server wallet identifier.');
    if (attachSigner) {
      await addSigners({ address: wallet.address, signers: [{ signerId: SIGNER_ID, policyIds: [POLICY_ID] }] });
    }
    const challenge = await adminRequest(`/v2/agents/${agent.id}/wallet/challenge`, {
      body: { walletAddress: wallet.address, privyWalletId: wallet.id, signerId: SIGNER_ID, policyId: POLICY_ID },
    });
    const { signature } = await signTypedData(challenge, { address: wallet.address });
    return adminRequest(`/v2/agents/${agent.id}/wallet`, {
      body: {
        walletAddress: wallet.address,
        privyWalletId: wallet.id,
        signerId: SIGNER_ID,
        policyId: POLICY_ID,
        signedAt: Number(challenge.message.signedAt),
        signature,
      },
    });
  };

  const createSecureAgent = () => run('quick-create', async () => {
    if (!SIGNER_ID || !POLICY_ID) throw new Error('The reviewed Privy signer policy is not configured.');
    const administrator = requireInstitutionAdminWallet();
    const createdAgent = await adminRequest('/v2/agents', { body: { name: name.trim(), adminWallet: administrator } });
    setSelectedId(createdAgent.id);
    try {
      const wallet = await createWallet({
        ...(embeddedWallets.length ? { createAdditional: true } : {}),
        signers: [{ signerId: SIGNER_ID, policyIds: [POLICY_ID] }],
      });
      await bindAgentWallet(createdAgent, wallet, false);
      setNotice(`Secure agent created with policy-bound wallet ${short(wallet.address)}.`);
    } catch (reason) {
      await loadAgents(createdAgent.id);
      throw new Error(`Agent record was created, but wallet setup needs retrying: ${reason.message || 'wallet creation failed'}`);
    }
    return { agentId: createdAgent.id };
  });

  const createDedicatedWallet = () => run('create-wallet', async () => {
    if (!detail?.agent) throw new Error('Create an agent record first.');
    if (!SIGNER_ID || !POLICY_ID) throw new Error('The deployment is missing the reviewed Privy agent signer or policy ID.');
    if (detail.agent.walletAddress) throw new Error('This agent already has a bound wallet.');
    const options = {
      ...(embeddedWallets.length ? { createAdditional: true } : {}),
      signers: [{ signerId: SIGNER_ID, policyIds: [POLICY_ID] }],
    };
    const wallet = await createWallet(options);
    await bindAgentWallet(detail.agent, wallet, false);
    setNotice(`Dedicated agent wallet ${short(wallet.address)} created, policy-bound, and cryptographically linked.`);
    return { agentId: detail.agent.id };
  });

  const repairSigner = (wallet) => run('repair-signer', async () => {
    if (!detail?.agent || !SIGNER_ID || !POLICY_ID) throw new Error('Signer policy configuration is incomplete.');
    await bindAgentWallet(detail.agent, wallet, true);
    setNotice(`Reviewed server signer attached and wallet ${short(wallet.address)} bound.`);
    return { agentId: detail.agent.id };
  });

  const enrollCvi = () => run('enroll-cvi', async () => {
    const result = await adminRequest(`/v2/agents/${selectedId}/cvi/enroll-uat`, { body: {} });
    setNotice(result.existing ? 'Existing active Cleanverse UAT A-Pass confirmed.' : 'Synthetic UAT A-Pass submitted to Cleanverse. Allow indexing before refreshing compliance.');
    return { agentId: selectedId };
  });

  const mandateAssets = () => {
    const rows = [...selectedAssets];
    if (manualAsset.trim()) rows.push(manualAsset.trim());
    const normalized = normalizeAddresses(rows.join(','), 'Allowed assets');
    if (!normalized.length) throw new Error('Select at least one issued CVA.');
    return normalized;
  };

  const submitMandate = async () => {
    const agent = detail?.agent;
    if (!agent?.walletAddress) throw new Error('Bind a dedicated agent wallet first.');
    if (!selectedActions.length) throw new Error('Select at least one allowed action.');
    const now = Math.floor(Date.now() / 1_000);
    const constraints = {
      allowedActions: selectedActions,
      allowedAssets: mandateAssets(),
      maxPerTransaction: toBaseUnits(maxPerTransaction),
      maxDailyNotional: toBaseUnits(maxDailyNotional),
      autoExecuteUpTo: toBaseUnits(autoExecuteUpTo),
      minAnnualRateBps: Math.round(Number(minRate) * 100),
      maxAnnualRateBps: Math.round(Number(maxRate) * 100),
      minDurationSeconds: Number(minDuration),
      maxDurationSeconds: Number(maxDuration),
      allowedCounterparties: normalizeAddresses(counterparties, 'Allowed counterparties'),
      allowedRecipients: normalizeAddresses(recipients, 'Allowed recipients'),
      startsAt: now,
      expiresAt: now + Number(mandateDays) * 86_400,
      nonce: String(Date.now()),
    };
    const unsigned = { wallet: agent.walletAddress, manifestHash: RWCAR_AGENT_MANIFEST.sha256, constraints };
    const challenge = await adminRequest(`/v2/agents/${selectedId}/mandates/challenge`, { body: unsigned });
    const administrator = requireInstitutionAdminWallet();
    const { signature } = await signTypedData(challenge.typedData, { address: administrator });
    return adminRequest(`/v2/agents/${selectedId}/mandates`, { body: { ...unsigned, signature } });
  };

  const signMandate = () => run('sign-mandate', async () => {
    await submitMandate();
    setNotice('Institutional mandate signed. Live Cleanverse eligibility was evaluated against every allowed asset.');
    return { agentId: selectedId };
  });

  const verifyAndAuthorize = () => run('quick-authorize', async () => {
    await adminRequest(`/v2/agents/${selectedId}/cvi/enroll-uat`, { body: {} });
    const result = await submitMandate();
    let compliance = result.compliance;
    for (let attempt = 0; compliance?.active !== true && attempt < 5; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1_500));
      compliance = await adminRequest(`/v2/agents/${selectedId}/compliance/refresh`, { body: {} });
    }
    if (compliance?.active !== true) {
      throw new Error(`Identity was submitted, but activation is still pending: ${(compliance?.reasons || []).join(', ') || 'retry live compliance shortly'}`);
    }
    setNotice('Identity verified and institutional mandate activated. Your agent is ready for credentials.');
    return { agentId: selectedId };
  });

  const refreshCompliance = () => run('refresh-compliance', async () => {
    const result = await adminRequest(`/v2/agents/${selectedId}/compliance/refresh`, { body: {} });
    setNotice(result.active ? 'Agent CVI, CVA, policy pool, and mandate checks all passed.' : `Agent remains gated: ${(result.reasons || []).join(', ') || 'checks pending'}.`);
    return { agentId: selectedId };
  });

  const issueCredential = () => run('issue-credential', async () => {
    if (!credentialScopes.length) throw new Error('Select at least one OAuth scope.');
    const created = await adminRequest(`/v2/agents/${selectedId}/credentials`, {
      body: { label: credentialLabel.trim(), scopes: credentialScopes },
    });
    setCredentialReveal(created);
    setNotice('Credential issued. Its secret is shown once—store it in the agent runtime secret manager now.');
    return { agentId: selectedId };
  });

  const issueReadOnlyCredential = () => run('quick-credential', async () => {
    const scopes = ['protocol:read'];
    const created = await adminRequest(`/v2/agents/${selectedId}/credentials`, {
      body: { label: 'Judge read-only MCP credential', scopes },
    });
    setCredentialScopes(scopes);
    setCredentialReveal(created);
    setNotice('Read-only credential created. Copy the secret now—it is shown only once.');
    return { agentId: selectedId };
  });

  const revokeCredential = (credentialId) => run('revoke-credential', async () => {
    await adminRequest(`/v2/agents/${selectedId}/credentials/${credentialId}`, { method: 'DELETE' });
    setNotice('Credential revoked immediately. Existing access tokens will fail revocation checks.');
    return { agentId: selectedId };
  });

  const changeStatus = (status) => run(`status-${status}`, async () => {
    if (status === 'REVOKED' && !window.confirm('Permanently revoke this agent and all of its credentials?')) return { agentId: selectedId };
    await adminRequest(`/v2/agents/${selectedId}/status`, { body: { status } });
    setNotice(status === 'ACTIVE' ? 'Agent activated after live mandate and compliance checks.' : `Agent ${status.toLowerCase()}.`);
    return { agentId: selectedId };
  });

  const decideIntent = (intent, decision) => run(`intent-${intent.intentId}`, async () => {
    const challenge = await adminRequest(`/v2/agents/${selectedId}/intents/${intent.intentId}/approval/challenge`, { body: { decision } });
    const administrator = requireInstitutionAdminWallet();
    const { signature } = await signTypedData(challenge, { address: administrator });
    await adminRequest(`/v2/agents/${selectedId}/intents/${intent.intentId}/approval`, {
      body: { decision, expiresAt: Number(challenge.message.expiresAt), signature },
    });
    setNotice(`Intent ${decision === 'APPROVE' ? 'approved' : 'rejected'} with an expiring EIP-712 authorization.`);
    return { agentId: selectedId };
  });

  const copy = async (value) => {
    try { await navigator.clipboard.writeText(value); setNotice('Copied to clipboard.'); }
    catch { setError('Clipboard access was blocked. Copy the value manually.'); }
  };

  if (!authenticated) return <div className="page-view agent-console"><div className="agent-hero card"><span className="agent-orbit">AI</span><div><span className="section-eyebrow">Institutional automation</span><h2>RWCAR Agent Console</h2><p>Connect the institution administrator wallet to provision bounded, compliant AI execution.</p><button className="button primary" onClick={login}>Connect Administrator</button></div></div></div>;

  const agent = detail?.agent;
  const activeMandate = detail?.mandates?.find((item) => item.status === 'ACTIVE' && new Date(item.expiresAt) > new Date());
  const activeCredentials = detail?.credentials?.filter((item) => item.status === 'ACTIVE') || [];
  const readCredential = activeCredentials.find((item) => item.scopes?.includes('protocol:read'));
  const signerConfigured = Boolean(SIGNER_ID && POLICY_ID);
  const authorizationReady = Boolean(agent?.cviActive && activeMandate && agent.status === 'ACTIVE');
  const guidedStep = !agent?.walletAddress ? 1 : !authorizationReady ? 2 : !readCredential ? 3 : 4;
  const credentialRevealPanel = credentialReveal && <div className="agent-secret-reveal"><div><strong>Save this secret now</strong><button type="button" onClick={() => setCredentialReveal(null)}>Hide permanently</button></div><label>Client ID<span><code>{credentialReveal.clientId}</code><button type="button" onClick={() => copy(credentialReveal.clientId)}>Copy</button></span></label><label>Client secret<span><code>{credentialReveal.clientSecret}</code><button type="button" onClick={() => copy(credentialReveal.clientSecret)}>Copy</button></span></label><label>OAuth resource<span><code>{API_URL}/mcp</code><button type="button" onClick={() => copy(`${API_URL}/mcp`)}>Copy</button></span></label><p>Store the client ID and secret in the AI agent's secret manager. The agent exchanges them for five-minute access tokens.</p></div>;

  return <div className="page-view agent-console">
    <div className="agent-console-heading">
      <div><span className="section-eyebrow">AI-ready repo market</span><h2>Connect an AI Agent</h2><p>Give an agent safe, verified access to RWCAR in three guided steps.</p></div>
      <div className="agent-discovery-links"><span>3-step setup</span><span>Real Cleanverse checks</span><span>Read-only by default</span></div>
    </div>

    {error && <div className="runtime-banner error agent-banner"><span>{error}</span><button type="button" onClick={() => setError('')}>Dismiss</button></div>}
    {notice && <div className="runtime-banner success agent-banner"><span>{notice}</span><button type="button" onClick={() => setNotice('')}>Dismiss</button></div>}
    {!signerConfigured && <div className="runtime-banner warning agent-banner">Agent wallet creation is locked until the reviewed Privy signer and policy IDs are configured.</div>}

    <div className="agent-layout">
      <aside className="card agent-list-panel">
        <div className="agent-panel-title"><div><span>Institution</span><strong>{institution?.name || 'Not created'}</strong></div><button type="button" onClick={() => loadAgents()} disabled={loading}>↻</button></div>
        <div className="agent-list">{agents.map((item) => <button key={item.id} type="button" className={selectedId === item.id ? 'active' : ''} onClick={() => { setSelectedId(item.id); void loadDetail(item.id); }}>
          <span className="agent-avatar">{item.name.slice(0, 2).toUpperCase()}</span><div><strong>{item.name}</strong><small>{short(item.walletAddress)}</small></div><AgentState value={item.status}/>
        </button>)}</div>
        <details className="agent-sidebar-advanced"><summary>+ Add another agent</summary><div className="agent-create-mini"><label>Agent name<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)}/></label><button className="button secondary full" type="button" disabled={Boolean(working) || name.trim().length < 2} onClick={createAgentRecord}>{working === 'create-agent' ? 'Creating…' : 'Create record only'}</button></div></details>
      </aside>

      <section className="agent-main">
        {!agent ? <section className="card agent-quickstart agent-quickstart-empty"><div className="agent-quickstart-number">1</div><div className="agent-quickstart-copy"><span className="section-eyebrow">Step 1 of 3</span><h3>{loading ? 'Loading agent registry…' : 'Create a secure AI agent'}</h3><p>One click creates the agent record and its isolated, policy-bound Privy wallet. No private key is exported.</p><label>Agent name<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)}/></label><button className="button primary" type="button" disabled={loading || Boolean(working) || name.trim().length < 2 || !signerConfigured} onClick={createSecureAgent}>{working === 'quick-create' ? 'Creating secure agent…' : 'Create Secure Agent'}</button></div></section> : <>
          <section className="card agent-overview">
            <div className="agent-overview-main"><span className="agent-avatar large">{agent.name.slice(0, 2).toUpperCase()}</span><div><span className="section-eyebrow">Agent identity</span><h3>{agent.name}</h3><p>{agent.walletAddress || 'Dedicated wallet not created'}{agent.walletAddress && <button type="button" className="agent-copy-inline" onClick={() => copy(agent.walletAddress)}>Copy</button>}</p></div></div>
            <div className="agent-overview-status"><AgentState value={agent.status}/><small>Updated {dateTime(agent.updatedAt)}</small></div>
            <div className="agent-setup-track">
              <SetupStep number="1" title="Secure agent" complete={Boolean(agent.walletAddress)} detail={agent.walletAddress ? 'Policy wallet ready' : 'Create wallet'}/>
              <SetupStep number="2" title="Verify & authorize" complete={authorizationReady} detail={authorizationReady ? 'CVI + mandate active' : 'One signature'}/>
              <SetupStep number="3" title="Connect AI" complete={Boolean(readCredential)} detail={readCredential ? 'Read-only credential ready' : 'Generate access'}/>
            </div>
          </section>

          <section className={`card agent-quickstart step-${guidedStep}`}>
            <div className="agent-quickstart-progress"><span>{guidedStep === 4 ? 'Ready' : `Step ${guidedStep} of 3`}</span><div>{[1, 2, 3].map((step) => <i key={step} className={guidedStep > step ? 'complete' : guidedStep === step ? 'current' : ''}/>)}</div></div>
            {guidedStep === 1 && <div className="agent-quickstart-action"><div className="agent-quickstart-number">1</div><div className="agent-quickstart-copy"><span>Secure identity</span><h3>Create the agent wallet</h3><p>RWCAR creates one isolated wallet and attaches the reviewed deny-by-default signing policy.</p><button className="button primary" type="button" disabled={Boolean(working) || !signerConfigured} onClick={createDedicatedWallet}>{working === 'create-wallet' ? 'Creating secure wallet…' : 'Create Secure Wallet'}</button></div></div>}
            {guidedStep === 2 && <div className="agent-quickstart-action"><div className="agent-quickstart-number">2</div><div className="agent-quickstart-copy"><span>Cleanverse + authority</span><h3>{activeMandate ? 'Finish the live verification' : 'Verify and authorize the agent'}</h3><p>{activeMandate ? 'The mandate exists. Run the final live CVI, CVA and policy-pool check.' : 'One click enrolls the agent A-Pass, then asks the institution administrator for one clear mandate signature.'}</p><div className="agent-quickstart-facts"><span>Real UAT A-Pass</span><span>RWRN01 only</span><span>7-day mandate</span></div><button className="button primary" type="button" disabled={Boolean(working) || !institutionAdminWallet} onClick={activeMandate ? refreshCompliance : verifyAndAuthorize}>{working === 'quick-authorize' || working === 'refresh-compliance' ? 'Verifying live controls…' : activeMandate ? 'Complete Live Verification' : 'Verify Identity & Sign Mandate'}</button><small>The wallet prompt must show the institution administrator—not the agent wallet.</small></div></div>}
            {guidedStep === 3 && <div className="agent-quickstart-action"><div className="agent-quickstart-number">3</div><div className="agent-quickstart-copy"><span>Connect your AI</span><h3>Generate a read-only credential</h3><p>This credential is enough for the judge flow and cannot create or execute transactions.</p><div className="agent-quickstart-facts"><span>get_protocol_info</span><span>list_verified_assets</span><span>check_eligibility</span></div><button className="button primary" type="button" disabled={Boolean(working)} onClick={issueReadOnlyCredential}>{working === 'quick-credential' ? 'Creating credential…' : 'Generate Read-only Credential'}</button></div></div>}
            {guidedStep === 4 && <div className="agent-quickstart-action ready"><div className="agent-quickstart-number">✓</div><div className="agent-quickstart-copy"><span>Connection ready</span><h3>Your AI agent can join RWCAR</h3><p>Store the client ID and secret in OpenClaw or Hermes. It will exchange them for short-lived access tokens.</p><div className="agent-connect-grid"><a href={`${API_URL}/agent-skill/SKILL.md`} target="_blank" rel="noreferrer"><span>Agent instructions</span><strong>SKILL.md ↗</strong></a><div><span>MCP endpoint</span><strong>{API_URL}/mcp</strong></div></div>{!credentialReveal && <button className="button secondary" type="button" disabled={Boolean(working)} onClick={issueReadOnlyCredential}>{working === 'quick-credential' ? 'Creating…' : 'Issue another read-only credential'}</button>}</div></div>}
            {credentialRevealPanel}
          </section>

          <details className="agent-advanced-console">
            <summary><span>Advanced institutional controls</span><small>Policy limits, write scopes, recovery, credentials and execution audit</small></summary>
            <div className="agent-advanced-sections">

          <section className="card agent-section">
            <div className="agent-section-head"><div><span>Agent administration</span><h3>Status & execution funding</h3><p>Operational controls for transaction-capable agents. The guided judge credential remains read-only.</p></div><AgentState value={agent.status}/></div>
            {agent.walletAddress && <div className={`agent-gas-health ${detail.walletHealth?.gasReady ? 'ready' : 'empty'}`}><span>Execution gas</span><strong>{formatMon(detail.walletHealth?.nativeBalance)}</strong><small>{detail.walletHealth?.gasReady ? 'Monad signer ready' : 'Fund this address with testnet MON before execution'}</small></div>}
            <div className="agent-status-actions">
              {agent.status === 'ACTIVE' && <button className="button secondary small" disabled={Boolean(working)} onClick={() => changeStatus('PAUSED')}>Pause agent</button>}
              {agent.status === 'PAUSED' && <button className="button secondary small" disabled={Boolean(working)} onClick={() => changeStatus('ACTIVE')}>Reactivate</button>}
              {agent.status !== 'REVOKED' && <button className="button danger small" disabled={Boolean(working)} onClick={() => changeStatus('REVOKED')}>Revoke</button>}
            </div>
          </section>

          {!agent.walletAddress && <section className="card agent-section">
            <div className="agent-section-head"><div><span>Step 01</span><h3>Dedicated Privy wallet</h3><p>A separate user-controlled server wallet receives only the deny-by-default execution policy.</p></div><span className="agent-security-chip">No private-key export</span></div>
            <button className="button primary" type="button" disabled={Boolean(working) || !signerConfigured} onClick={createDedicatedWallet}>{working === 'create-wallet' ? 'Creating and binding…' : 'Create Policy-bound Wallet'}</button>
            {embeddedWallets.length > 0 && <details className="agent-recovery"><summary>Repair an existing dedicated wallet</summary><p>Use only a wallet created specifically for this agent. This attaches the reviewed signer policy before binding.</p><div>{embeddedWallets.map((wallet) => <button key={wallet.address} type="button" className="table-action" disabled={Boolean(working)} onClick={() => repairSigner(wallet)}>Attach & bind {short(wallet.address)}</button>)}</div></details>}
          </section>}

          {agent.walletAddress && <section className="card agent-section">
            <div className="agent-section-head"><div><span>Step 02</span><h3>Cleanverse agent identity</h3><p>The agent contract-facing wallet must hold its own active CVI/A-Pass before it can move a CVA.</p></div><AgentState value={agent.cviActive ? 'ACTIVE' : 'PENDING_CVI'}/></div>
            <div className="agent-uat-warning"><strong>Cleanverse UAT only</strong><span>This uses synthetic identity fields with the real encrypted `generate_apass` endpoint. It is not production KYC.</span></div>
            <div className="agent-inline-actions"><button className="button secondary" type="button" disabled={Boolean(working)} onClick={enrollCvi}>{working === 'enroll-cvi' ? 'Submitting…' : 'Enroll / Confirm UAT A-Pass'}</button><button className="button secondary" type="button" disabled={Boolean(working) || !activeMandate} onClick={refreshCompliance}>{working === 'refresh-compliance' ? 'Checking…' : 'Refresh Live Compliance'}</button></div>
          </section>}

          {agent.walletAddress && <section className="card agent-section">
            <div className="agent-section-head"><div><span>Step 03</span><h3>Institutional mandate</h3><p>Sign the exact skill hash, assets, actions, rate bands, duration bands, counterparties, recipients, and notional limits.</p></div><code className="agent-manifest-hash" title={RWCAR_AGENT_MANIFEST.sha256}>{RWCAR_AGENT_MANIFEST.sha256.slice(0, 14)}…{RWCAR_AGENT_MANIFEST.sha256.slice(-8)}</code></div>
            <div className="agent-form-grid three"><label>Max per transaction (aUSDC)<input value={maxPerTransaction} onChange={(event) => setMaxPerTransaction(event.target.value)}/></label><label>Daily notional cap (aUSDC)<input value={maxDailyNotional} onChange={(event) => setMaxDailyNotional(event.target.value)}/></label><label>Auto-execute up to (aUSDC)<input value={autoExecuteUpTo} onChange={(event) => setAutoExecuteUpTo(event.target.value)}/></label></div>
            <div className="agent-form-grid four"><label>Minimum APR %<input type="number" min="0" step="0.01" value={minRate} onChange={(event) => setMinRate(event.target.value)}/></label><label>Maximum APR %<input type="number" min="0" step="0.01" value={maxRate} onChange={(event) => setMaxRate(event.target.value)}/></label><label>Min duration (sec)<input type="number" min="1" value={minDuration} onChange={(event) => setMinDuration(event.target.value)}/></label><label>Max duration (sec)<input type="number" min="1" value={maxDuration} onChange={(event) => setMaxDuration(event.target.value)}/></label></div>
            <div className="agent-form-grid three"><label>Mandate lifetime (days)<input type="number" min="1" max="30" value={mandateDays} onChange={(event) => setMandateDays(event.target.value)}/></label><label>Allowed counterparties (optional)<input value={counterparties} onChange={(event) => setCounterparties(event.target.value)} placeholder="0x…, 0x…"/></label><label>Allowed recipients (optional)<input value={recipients} onChange={(event) => setRecipients(event.target.value)} placeholder="0x…, 0x…"/></label></div>
            <div className="agent-choice-block"><strong>Allowed verified assets</strong>{assets.length ? <div className="agent-asset-options">{assets.map((asset) => <label key={asset.address} className={selectedAssets.includes(asset.address) ? 'selected' : ''}><input type="checkbox" checked={selectedAssets.includes(asset.address)} onChange={() => setSelectedAssets(selectedAssets.includes(asset.address) ? selectedAssets.filter((item) => item !== asset.address) : [...selectedAssets, asset.address])}/><span>{asset.symbol || short(asset.address)}</span><small>{short(asset.address)}</small></label>)}</div> : <label className="agent-manual-asset">Issued CVA address<input value={manualAsset} onChange={(event) => setManualAsset(event.target.value)} placeholder="0x…"/></label>}</div>
            <div className="agent-choice-block"><strong>Allowed semantic actions</strong><ToggleGrid rows={ACTIONS} selected={selectedActions} onChange={setSelectedActions}/></div>
            <button className="button primary" type="button" disabled={Boolean(working) || !institutionAdminWallet} onClick={signMandate}>{working === 'sign-mandate' ? 'Awaiting administrator signature…' : activeMandate ? 'Replace Signed Mandate' : 'Sign Institutional Mandate'}</button>
            {activeMandate && <div className="agent-current-mandate"><span>Active mandate v{activeMandate.version}</span><span>Expires {dateTime(activeMandate.expiresAt)}</span><span>{activeMandate.allowedActions.length} actions · {activeMandate.allowedAssets.length} assets</span></div>}
          </section>}

          <section className="card agent-section">
            <div className="agent-section-head"><div><span>Step 04</span><h3>OAuth & MCP credentials</h3><p>Issue least-privilege client credentials only after wallet, mandate, and live compliance are active.</p></div><span className="agent-security-chip">5-minute JWTs</span></div>
            <div className="agent-form-grid two"><label>Credential label<input value={credentialLabel} onChange={(event) => setCredentialLabel(event.target.value)}/></label><div className="agent-endpoints"><span>Discovery</span><code>{API_URL}/agent-discovery.json</code><span>Token</span><code>{API_URL}/oauth/token</code><span>MCP / Resource</span><code>{API_URL}/mcp</code></div></div>
            <div className="agent-choice-block"><strong>Granted scopes</strong><ToggleGrid rows={SCOPES} selected={credentialScopes} onChange={setCredentialScopes}/></div>
            <button className="button primary" type="button" disabled={Boolean(working) || agent.status !== 'ACTIVE'} onClick={issueCredential}>{working === 'issue-credential' ? 'Hashing credential…' : 'Issue One-time Credential'}</button>
            <div className="agent-credential-list">{(detail.credentials || []).map((credential) => <div key={credential.id}><div><strong>{credential.label}</strong><code>{credential.clientId}</code><small>{credential.scopes.join(' · ')} · expires {dateTime(credential.expiresAt)} · last used {dateTime(credential.lastUsedAt)}</small></div><AgentState value={credential.status}/>{credential.status === 'ACTIVE' && <button type="button" className="table-action danger" disabled={Boolean(working)} onClick={() => revokeCredential(credential.id)}>Revoke</button>}</div>)}</div>
          </section>

          <section className="card agent-section agent-intents">
            <div className="agent-section-head"><div><span>Control room</span><h3>Durable execution intents</h3><p>Every intent is hash-bound, preflighted twice, serialized per wallet, and reconciled to the final indexer projection.</p></div><button className="button secondary small" type="button" disabled={loading} onClick={() => loadDetail(selectedId)}>Refresh</button></div>
            {(detail.intents || []).length ? <div className="agent-intent-list">{detail.intents.map((intent) => <article key={intent.intentId}>
              <div className="agent-intent-main"><AgentState value={intent.state}/><div><strong>{intent.action.replaceAll('_', ' ')}</strong><code>{intent.intentId}</code></div><div className="agent-intent-amount"><span>Reserved notional</span><strong>{intent.reservedNotional || '0'}</strong></div></div>
              <div className="agent-intent-meta"><span>Hash {intent.intentHash.slice(0, 14)}…</span><span>{dateTime(intent.createdAt)}</span>{intent.txHash && <a href={`https://testnet.monadscan.com/tx/${intent.txHash}`} target="_blank" rel="noreferrer">Monad tx ↗</a>}</div>
              {intent.transactionSummary?.length > 0 && <details><summary>{intent.transactionSummary.length} reviewed transaction step{intent.transactionSummary.length > 1 ? 's' : ''}</summary>{intent.transactionSummary.map((step) => <div className="agent-intent-step" key={step.stepIndex}><span>{step.stepIndex + 1}</span><p><strong>{step.description}</strong><small>{short(step.to)} · {step.selector} · {step.status}</small></p></div>)}</details>}
              {intent.state === 'APPROVAL_REQUIRED' && <div className="agent-approval-actions"><button className="button primary small" disabled={Boolean(working)} onClick={() => decideIntent(intent, 'APPROVE')}>Sign approval</button><button className="button danger small" disabled={Boolean(working)} onClick={() => decideIntent(intent, 'REJECT')}>Reject</button><small>{intent.approvalReason || 'Mandate requires human review'}</small></div>}
              {intent.errorMessage && <div className="agent-intent-error">{intent.errorCode || 'EXECUTION_ERROR'} · {intent.errorMessage}</div>}
            </article>)}</div> : <div className="agent-empty compact"><h3>No agent intents yet</h3><p>Authenticated agents will create durable preparations through REST or the 17-tool MCP surface.</p></div>}
          </section>
            </div>
          </details>
        </>}
      </section>
    </div>
  </div>;
}
