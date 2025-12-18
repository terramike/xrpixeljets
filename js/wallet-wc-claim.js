// wallet-wc-claim.js
// Handles claim logic, assumes WalletConnect is already initialized and connected.

import { SignClient } from '@walletconnect/sign-client';
import { getAddress, getSession, getClient } from './wallet-wc-connect.js';

let client = null;
let session = null;

// Set WC dependencies externally if needed
export function setWalletConnectContext({ signClient, activeSession }) {
  client = signClient;
  session = activeSession;
}

export async function signTx(tx, { autofill = false, submit = false } = {}) {
  if (!client || !session) throw new Error('[WC] Not connected');
  const address = getAddress();
  const chainId = session?.namespaces?.xrpl?.chains?.[0];

  if (!chainId) throw new Error('[WC] Chain ID not available');

  const request = {
    method: 'xrpl_signTransaction',
    params: {
      tx_json: tx,
      autofill,
      submit
    }
  };

  const result = await client.request({
    topic: session.topic,
    chainId,
    request
  });

  if (!result?.tx_blob && !result?.tx_json) {
    throw new Error('[WC] No signed blob or JSON returned');
  }

  return result;
}

export async function claimJets(serverBaseUrl) {
  const address = getAddress();
  if (!address) throw new Error('[WC] No address for claim');

  const res = await fetch(`${serverBaseUrl}/claim/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address })
  });
  const data = await res.json();
  const txJSON = typeof data.txJSON === 'string' ? JSON.parse(data.txJSON) : data.txJSON;

  const signed = await signTx(txJSON, { autofill: false, submit: false });

  if (!signed?.tx_blob) throw new Error('[WC] Claim signing failed');

  const verify = await fetch(`${serverBaseUrl}/session/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address,
      nonce: data.nonce,
      payload: data.payload,
      txProof: {
        tx_blob: signed.tx_blob,
        tx_hash: signed.tx_json?.hash
      }
    })
  });

  const verified = await verify.json();
  if (verified.error) throw new Error(`[WC] Claim failed: ${verified.error}`);

  return verified;
}
