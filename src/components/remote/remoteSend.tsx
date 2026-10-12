import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Send, X } from 'lucide-react';
import { ApiError } from '../../services/http';
import {
  COMMAND_LABELS, getRemoteCommand, getRemoteStatus, isFinal, queueAllShopsCommand, queueRemoteCommand,
  type AllShopsResult, type RemoteCommand, type RemoteStatus,
} from '../../services/remoteAdmin';
import { getSelectedShop } from '../../services/shopContext';
import { Sheet, StatusBadge, STATUS_TEXT, ago, btnPrimary, btnSecondary, describeResult, type Draft } from './remoteUi';

/** Actions that move stock or money: an offline shop gets the strongest warning before queueing. */
export const HIGH_CONFLICT_ACTIONS = ['stock-add', 'stock-remove', 'stock-set', 'batch-create', 'purchase-receive', 'return-approve', 'sale-void'];

/**
 * Shared "review -> confirm (target shop repeated) -> queue -> follow until APPLIED / REJECTED" flow
 * for the online management screens. Nothing is shown as done until the shop reports APPLIED.
 */
export function useRemoteSender(onApplied?: () => void) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tracked, setTracked] = useState<RemoteCommand[]>([]);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fanout, setFanout] = useState<AllShopsResult | null>(null);
  const appliedRef = useRef(onApplied);
  appliedRef.current = onApplied;

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await getRemoteStatus());
    } catch {
      /* the banner shows cloud trouble */
    }
  }, []);
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!tracked.some((c) => !isFinal(c.status))) return;
    const t = setTimeout(async () => {
      let applied = false;
      const next = await Promise.all(tracked.map(async (c) => {
        if (isFinal(c.status)) return c;
        try {
          const fresh = await getRemoteCommand(c.command_id);
          if (fresh.status === 'APPLIED') applied = true;
          return fresh;
        } catch {
          return c;
        }
      }));
      setTracked(next);
      if (applied) appliedRef.current?.();
    }, 4000);
    return () => clearTimeout(t);
  }, [tracked]);

  const review = (d: Draft) => {
    setError(null);
    setDraft(d);
  };

  const send = async () => {
    if (!draft) return;
    setSending(true);
    setError(null);
    try {
      if (draft.allShops) {
        setFanout(await queueAllShopsCommand(draft.action, draft.payload, getSelectedShop()?.shop_id ?? status?.shop_id ?? null, draft.requestId));
      } else {
        const q = await queueRemoteCommand(draft.action, draft.payload, draft.requestId);
        setNotice(q.warning || null);
        setTracked((t) => [{
          command_id: q.command_id, command_type: q.command_type, status: q.status, payload: draft.payload, entity_id: q.entity_id ?? null,
          created_at: q.created_at, created_by: null, delivered_at: null, delivery_count: 0, acked_at: null, result: null, error: null,
        }, ...t.filter((x) => x.command_id !== q.command_id)]);
      }
      setDraft(null);
      void loadStatus();
    } catch (err: any) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the online server. Nothing was queued; you can retry safely.');
    } finally {
      setSending(false);
    }
  };

  const confirmSheet = draft ? (
    <Sheet title={`${draft.allShops ? 'ALL SHOPS' : status?.shop_code || 'Shop'} — Confirm: ${draft.title}`} onClose={() => (sending ? null : setDraft(null))}>
      {draft.allShops ? (
        <div className="mb-2 rounded-lg border-2 border-rose-500 bg-rose-50 px-3 py-2 text-sm">
          <div className="text-[10px] font-bold uppercase tracking-wide text-rose-700">Target</div>
          <div className="font-bold text-rose-900">ALL SHOPS — one separate command for each active shop</div>
        </div>
      ) : (
        <div className="mb-2 rounded-lg border-2 border-amber-400 bg-amber-50 px-3 py-2 text-sm">
          <div className="text-[10px] font-bold uppercase tracking-wide text-amber-700">Target shop</div>
          <div className="font-bold text-amber-900">{status?.shop_name || status?.shop_code || 'Unknown shop'}{status?.shop_code ? ` (${status.shop_code})` : ''}</div>
        </div>
      )}
      {!draft.allShops && status && !status.shop_in_contact && (
        <div className={`mb-2 rounded-lg px-3 py-2 text-[12px] ${HIGH_CONFLICT_ACTIONS.includes(draft.action) ? 'border-2 border-rose-500 bg-rose-50 text-rose-900 font-semibold' : 'border border-amber-300 bg-amber-50 text-amber-900'}`}>
          {HIGH_CONFLICT_ACTIONS.includes(draft.action)
            ? 'The shop computer is OFFLINE. This stock / financial change waits and is checked against the shop\'s live data when it arrives; if anything changed meanwhile it is REJECTED, never forced.'
            : 'The shop computer is offline: the change waits as PENDING and is applied when it reconnects.'}
        </div>
      )}
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1.5 text-sm">
        {draft.lines.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3"><span className="text-slate-500">{k}</span><span className="font-semibold text-slate-900 text-right break-words">{v}</span></div>
        ))}
      </div>
      <p className="text-[11px] text-slate-500 mt-2">Sent to the shop computer and applied there in one database transaction. Status: PENDING, DELIVERED, then APPLIED or REJECTED (with the reason).</p>
      {error && <div className="mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}
      <div className="grid grid-cols-2 gap-2 mt-3">
        <button className={btnSecondary} disabled={sending} onClick={() => setDraft(null)}>Back</button>
        <button className={btnPrimary} disabled={sending} onClick={() => void send()}>
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Confirm
        </button>
      </div>
    </Sheet>
  ) : null;

  const trackedList = (
    <>
      {notice && (
        <div className="text-[12px] text-amber-900 bg-amber-50 border border-amber-300 rounded-lg p-2 flex gap-2">
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss"><X className="w-4 h-4" /></button>
        </div>
      )}
      {fanout && (
        <div className="bg-white border-2 border-teal-600 rounded-xl p-3 space-y-1">
          <div className="flex items-center justify-between">
            <div className="text-sm font-bold text-slate-900">Applied to all shops: {COMMAND_LABELS[fanout.command_type] || fanout.command_type}</div>
            <button onClick={() => setFanout(null)} aria-label="Dismiss"><X className="w-4 h-4 text-slate-500" /></button>
          </div>
          {fanout.results.map((r) => (
            <div key={r.shop_id} className="flex justify-between gap-2 text-xs border-t border-slate-100 pt-1">
              <span className="font-semibold">{r.shop_code} — {r.shop_name}</span>
              <span className={r.status === 'QUEUED' ? 'text-emerald-700 font-bold' : 'text-amber-700'}>{r.status === 'QUEUED' ? 'queued' : `skipped: ${r.reason}`}</span>
            </div>
          ))}
        </div>
      )}
      {tracked.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-bold text-slate-600 uppercase tracking-wide">Sent from this screen</div>
          {tracked.slice(0, 6).map((c) => (
            <div key={c.command_id} className="bg-white border border-slate-200 rounded-xl p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-slate-900 truncate">{COMMAND_LABELS[c.command_type] || c.command_type}</div>
                <StatusBadge status={c.status} />
              </div>
              <div className="text-[11px] text-slate-600 mt-1">{STATUS_TEXT[c.status]} · sent {ago(c.created_at)}</div>
              {c.status === 'APPLIED' && describeResult(c) && <div className="text-[12px] mt-1 text-emerald-800 font-medium">{describeResult(c)}</div>}
              {c.status === 'REJECTED' && c.error && <div className="text-[12px] mt-1 text-rose-800 bg-rose-50 rounded p-1.5">{c.error}</div>}
              {c.status === 'REJECTED' && c.result?.conflict && (
                <div className="text-[11px] mt-1 text-slate-700">Newer activity at the shop won: nothing was overwritten. Refresh and check the current values before sending again.</div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );

  return { review, confirmSheet, trackedList, status, reloadStatus: loadStatus };
}
