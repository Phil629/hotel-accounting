import React, { useState, useEffect } from 'react';
import { api } from '../api';

export interface AiTransaction {
  type: 'CARD' | 'BANK' | 'BOOKING';
  id: number;
  amount: number;
  date: string;
  details: string;
}

export interface AiMatchSuggestion {
  invoiceId: number;
  invoiceNumber: string;
  recipient: string;
  amount: number;
  date: string;
  status: 'PAID' | 'PARTIAL' | 'OPEN';
  headline: string;
  explanation: string;
  confidence: number;
  suggestedComment: string;
  matchedTransactions: AiTransaction[];
  geminiUsed: boolean;
}

interface AiInspectionModalProps {
  invoice: any | null;
  isOpen: boolean;
  onClose: () => void;
  onApplied: (invoiceId: number, status: 'PAID' | 'PARTIAL' | 'OPEN', amount: number, comment: string) => void;
}

export const fixEncoding = (str?: string | null): string => {
  if (!str) return '';
  return str
    .replace(/Ã¼/g, 'ü')
    .replace(/Ã¤/g, 'ä')
    .replace(/Ã¶/g, 'ö')
    .replace(/ÃŸ/g, 'ß')
    .replace(/Ãœ/g, 'Ü')
    .replace(/Ã„/g, 'Ä')
    .replace(/Ã–/g, 'Ö')
    .replace(/â‚¬/g, '€');
};

export const AiInspectionModal: React.FC<AiInspectionModalProps> = ({
  invoice,
  isOpen,
  onClose,
  onApplied,
}) => {
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<AiMatchSuggestion | null>(null);
  const [commentInput, setCommentInput] = useState('');
  
  // Optional Gemini API Key
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('GEMINI_API_KEY') || '');
  const [showKeyConfig, setShowKeyConfig] = useState(false);

  const handleSaveApiKey = (newKey: string) => {
    const trimmed = newKey.trim();
    setApiKey(trimmed);
    localStorage.setItem('GEMINI_API_KEY', trimmed);
  };

  const runInvestigation = async (overrideKey?: string) => {
    if (!invoice) return;
    setLoading(true);
    setError(null);
    setSuggestion(null);

    const effectiveKey = (typeof overrideKey === 'string' ? overrideKey : apiKey).trim();

    try {
      const res = await api.checkInvoiceWithAI(invoice.id, effectiveKey || undefined);
      setSuggestion(res);
      setCommentInput(res.suggestedComment || '');
    } catch (e: any) {
      const msg = e.message || 'Die KI-Prüfung konnte nicht durchgeführt werden.';
      setError(msg);
      if (msg.toLowerCase().includes('api-key') || msg.toLowerCase().includes('api_key')) {
        setShowKeyConfig(true);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && invoice) {
      runInvestigation();
    }
  }, [isOpen, invoice?.id]);

  if (!isOpen || !invoice) return null;

  // Financial calculations
  const totalAmount = Number(suggestion?.amount ?? invoice?.amount ?? 0);

  // Reject any match whose amount exceeds total invoice amount
  const validMatchedTransactions = (suggestion?.matchedTransactions || []).filter(
    t => Number(t.amount || 0) <= totalAmount + 0.05
  );

  const matchedSum = validMatchedTransactions.reduce(
    (sum, t) => sum + Number(t.amount || 0),
    0
  );

  let effectiveStatus: 'PAID' | 'PARTIAL' | 'OPEN' = suggestion?.status || 'OPEN';
  let paidAmount = 0;
  if (suggestion) {
    if (validMatchedTransactions.length === 0) {
      paidAmount = 0;
      effectiveStatus = 'OPEN';
    } else if (suggestion.status === 'PAID' || Math.abs(matchedSum - totalAmount) < 0.05) {
      paidAmount = totalAmount;
      effectiveStatus = 'PAID';
    } else {
      paidAmount = Math.min(totalAmount, matchedSum > 0 ? matchedSum : (Number(invoice?.amountPaid) || 0));
      effectiveStatus = 'PARTIAL';
    }
  }

  const openAmount = Math.max(0, Math.round((totalAmount - paidAmount) * 100) / 100);
  if (openAmount <= 0.01 && paidAmount > 0) {
    effectiveStatus = 'PAID';
  }
  const paidPct = totalAmount > 0 ? Math.min(100, Math.max(0, Math.round((paidAmount / totalAmount) * 100))) : 0;
  const openPct = 100 - paidPct;

  // Group PMS payments by payment type and calculate net amounts (netting out Stornos)
  const pmsNetByType: Record<string, number> = {};
  for (const p of (invoice.pmsPayments || [])) {
    const type = p.paymentType || 'Zahlung';
    pmsNetByType[type] = (pmsNetByType[type] || 0) + Number(p.amount || 0);
  }

  // Deduct already validated matches from these expectations
  const remainingExpectedByType: { type: string; amount: number }[] = [];
  for (const [type, netExpected] of Object.entries(pmsNetByType)) {
    if (netExpected <= 0.01) continue; // Ignore net zero or storno positions
    const covered = validMatchedTransactions
      .filter(m => {
        const d = (m.details || '').toLowerCase();
        const t = (m.type || '').toLowerCase();
        const pType = type.toLowerCase();
        return d.includes(pType)
          || (pType.includes('mastercard') && (d.includes('mastercard') || t === 'card'))
          || (pType.includes('visa') && (d.includes('visa') || t === 'card'))
          || (pType.includes('girocard') && (d.includes('girocard') || t === 'card'))
          || (pType.includes('booking') && (d.includes('booking') || t === 'booking'))
          || (pType.includes('paypal') && (d.includes('paypal') || t === 'card'));
      })
      .reduce((sum, m) => sum + Number(m.amount || 0), 0);

    const stillNeeded = Math.max(0, Math.round((netExpected - covered) * 100) / 100);
    if (stillNeeded > 0.01) {
      remainingExpectedByType.push({ type, amount: stillNeeded });
    }
  }

  // Fallback if openAmount remains but no specific PMS breakdown left
  if (remainingExpectedByType.length === 0 && openAmount > 0.01) {
    remainingExpectedByType.push({
      type: invoice.paymentType || 'Offene Forderung',
      amount: openAmount,
    });
  }

  const handleSaveCommentOnly = async () => {
    if (!invoice) return;
    setApplying(true);
    setError(null);

    try {
      await api.updateComment(invoice.id, undefined, commentInput);
      onApplied(invoice.id, 'OPEN', Number(invoice.amountPaid) || 0, commentInput);
      onClose();
    } catch (e: any) {
      setError(e.message || 'Konnte die KI-Notiz nicht speichern.');
    } finally {
      setApplying(false);
    }
  };

  const handleApply = async () => {
    if (!suggestion) return;
    setApplying(true);
    setError(null);

    const actualPaid = effectiveStatus === 'PAID'
      ? totalAmount
      : (matchedSum > 0 ? matchedSum : (Number(invoice.amountPaid) || 0));

    try {
      await api.applyAiMatch(invoice.id, {
        status: effectiveStatus,
        amountPaid: actualPaid,
        aiComment: commentInput,
        matches: validMatchedTransactions.map(t => ({
          type: t.type,
          id: t.id,
        })),
      });

      onApplied(invoice.id, effectiveStatus, actualPaid, commentInput);
      onClose();
    } catch (e: any) {
      setError(e.message || 'Konnte den Vorschlag nicht übernehmen.');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(15, 23, 42, 0.65)',
      backdropFilter: 'blur(3px)',
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '16px',
    }}>
      <div style={{
        background: '#ffffff',
        borderRadius: '16px',
        width: '100%',
        maxWidth: '680px',
        maxHeight: '92vh',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
        overflow: 'hidden',
        border: '1px solid #cbd5e1',
      }}>
        {/* Header */}
        <div style={{
          padding: '18px 24px',
          borderBottom: '1px solid #f1f5f9',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          background: 'linear-gradient(to right, #faf5ff, #f0fdf4)',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '1.25rem' }}>✨</span>
              <h3 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: '#1e1b4b' }}>
                KI-Prüfung: Rechnung #{invoice.invoiceNumber}
              </h3>
            </div>
            <div style={{ fontSize: '0.85rem', color: '#64748b', marginTop: '4px' }}>
              <strong>{fixEncoding(invoice.recipient)}</strong> • {Number(invoice.amount).toFixed(2)} € • {new Date(invoice.invoiceDate).toLocaleDateString('de-DE')}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: '1.4rem',
              color: '#94a3b8',
              cursor: 'pointer',
              lineHeight: 1,
              padding: '4px',
            }}
            title="Schließen"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {loading && (
            <div style={{ textAlign: 'center', padding: '40px 20px' }}>
              <div style={{
                width: '44px',
                height: '44px',
                margin: '0 auto 16px',
                border: '4px solid #e0e7ff',
                borderTopColor: '#6366f1',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
              }} />
              <div style={{ fontSize: '1rem', fontWeight: 600, color: '#312e81' }}>
                KI analysiert Zahlungen...
              </div>
              <div style={{ fontSize: '0.85rem', color: '#64748b', marginTop: '6px' }}>
                Durchsuche ungematchte Banküberweisungen, Terminal-Zahlungen und Booking-Auszahlungen...
              </div>
            </div>
          )}

          {error && (
            <div style={{
              background: '#fef2f2',
              border: '1.5px solid #fecaca',
              borderRadius: '12px',
              padding: '16px 20px',
              color: '#991b1b',
              fontSize: '0.9rem',
            }}>
              <div style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: '6px' }}>
                Fehler: {error}
              </div>
              <div style={{ fontSize: '0.85rem', color: '#7f1d1d', marginTop: '6px', marginBottom: '12px', lineHeight: 1.4 }}>
                Füge hier deinen Google Gemini API-Key ein, um die direkte KI-Prüfung zu starten:
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  type="text"
                  placeholder="API-Key hier einfügen (AQ.Ab8...)"
                  value={apiKey}
                  onChange={(e) => handleSaveApiKey(e.target.value)}
                  style={{
                    flex: 1,
                    padding: '8px 12px',
                    fontSize: '0.88rem',
                    border: '1px solid #cbd5e1',
                    borderRadius: '8px',
                    background: '#ffffff',
                    color: '#0f172a',
                  }}
                />
                <button
                  type="button"
                  onClick={() => runInvestigation(apiKey)}
                  style={{
                    background: '#4f46e5',
                    color: 'white',
                    border: 'none',
                    padding: '8px 16px',
                    borderRadius: '8px',
                    fontSize: '0.88rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    boxShadow: '0 1px 3px rgba(79, 70, 229, 0.3)',
                  }}
                >
                  Key speichern & Prüfen
                </button>
              </div>
            </div>
          )}

          {!loading && suggestion && (
            <>
              {/* 1. Status Banner */}
              <div style={{
                padding: '12px 16px',
                borderRadius: '10px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                backgroundColor: effectiveStatus === 'PAID' ? '#f0fdf4' : effectiveStatus === 'PARTIAL' ? '#fffbeb' : '#fef2f2',
                border: `1.5px solid ${effectiveStatus === 'PAID' ? '#86efac' : effectiveStatus === 'PARTIAL' ? '#fde68a' : '#fecaca'}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '1.4rem' }}>
                    {effectiveStatus === 'PAID' ? '🟢' : effectiveStatus === 'PARTIAL' ? '🟡' : '🔴'}
                  </span>
                  <div>
                    <div style={{
                      fontWeight: 700,
                      fontSize: '0.96rem',
                      color: effectiveStatus === 'PAID' ? '#166534' : effectiveStatus === 'PARTIAL' ? '#92400e' : '#991b1b',
                    }}>
                      {effectiveStatus === 'PAID'
                        ? 'VOLLSTÄNDIG BEZAHLT'
                        : effectiveStatus === 'PARTIAL'
                        ? 'TEILWEISE BEZAHLT – RESTBETRAG AUSSTEHEND'
                        : 'RECHNUNG VOLLSTÄNDIG OFFEN'}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                      {effectiveStatus === 'PAID'
                        ? 'Rechnung ist vollkommen ausgeglichen.'
                        : effectiveStatus === 'PARTIAL'
                        ? `${paidAmount.toFixed(2)} € nachgewiesen, ${openAmount.toFixed(2)} € noch offen.`
                        : 'Bisher kein entsprechender Geldeingang gefunden.'}
                      {' • '}Konfidenz: {Math.round(suggestion.confidence * 100)}% {suggestion.geminiUsed && '• Mit Gemini AI'}
                    </div>
                  </div>
                </div>
              </div>

              {/* 2. Visual 3-Card Summary Grid: Gesamt / Bezahlt / Offen */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '12px',
              }}>
                {/* Gesamt */}
                <div style={{
                  background: '#f8fafc',
                  border: '1.5px solid #e2e8f0',
                  borderRadius: '12px',
                  padding: '12px 14px',
                  textAlign: 'center',
                }}>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Gesamtbetrag
                  </div>
                  <div style={{ fontSize: '1.45rem', fontWeight: 800, color: '#0f172a', margin: '4px 0 2px' }}>
                    {totalAmount.toFixed(2)} €
                  </div>
                  <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                    Rechnungssumme
                  </div>
                </div>

                {/* Bereits bezahlt */}
                <div style={{
                  background: paidAmount > 0 ? '#f0fdf4' : '#f8fafc',
                  border: `1.5px solid ${paidAmount > 0 ? '#86efac' : '#e2e8f0'}`,
                  borderRadius: '12px',
                  padding: '12px 14px',
                  textAlign: 'center',
                }}>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, color: paidAmount > 0 ? '#15803d' : '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    ✓ Bereits bezahlt
                  </div>
                  <div style={{ fontSize: '1.45rem', fontWeight: 800, color: paidAmount > 0 ? '#166534' : '#64748b', margin: '4px 0 2px' }}>
                    {paidAmount.toFixed(2)} €
                  </div>
                  <div style={{ fontSize: '0.72rem', fontWeight: 600, color: paidAmount > 0 ? '#15803d' : '#94a3b8' }}>
                    {paidPct}% beglichen
                  </div>
                </div>

                {/* Noch offen */}
                <div style={{
                  background: openAmount > 0 ? '#fef2f2' : '#f8fafc',
                  border: `1.5px solid ${openAmount > 0 ? '#fca5a5' : '#e2e8f0'}`,
                  borderRadius: '12px',
                  padding: '12px 14px',
                  textAlign: 'center',
                }}>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, color: openAmount > 0 ? '#b91c1c' : '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    ⚠ Noch offen
                  </div>
                  <div style={{ fontSize: '1.45rem', fontWeight: 800, color: openAmount > 0 ? '#dc2626' : '#64748b', margin: '4px 0 2px' }}>
                    {openAmount.toFixed(2)} €
                  </div>
                  <div style={{ fontSize: '0.72rem', fontWeight: 600, color: openAmount > 0 ? '#b91c1c' : '#94a3b8' }}>
                    {openPct}% ausstehend
                  </div>
                </div>
              </div>

              {/* 3. Dual-Color Split Bar */}
              <div>
                <div style={{
                  height: '10px',
                  width: '100%',
                  backgroundColor: '#fee2e2',
                  borderRadius: '999px',
                  overflow: 'hidden',
                  display: 'flex',
                }}>
                  <div style={{
                    width: `${paidPct}%`,
                    backgroundColor: '#22c55e',
                    transition: 'width 0.3s ease',
                  }} />
                  <div style={{
                    width: `${openPct}%`,
                    backgroundColor: '#ef4444',
                    transition: 'width 0.3s ease',
                  }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginTop: '4px' }}>
                  <span style={{ color: '#16a34a', fontWeight: 600 }}>● {paidAmount.toFixed(2)} € bezahlt ({paidPct}%)</span>
                  <span style={{ color: '#dc2626', fontWeight: 600 }}>● {openAmount.toFixed(2)} € ausstehend ({openPct}%)</span>
                </div>
              </div>

              {/* 4. Two Clean Breakdown Sections: Paid vs Open */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {/* Green Box: Erhaltene Zahlungen */}
                <div style={{
                  background: '#f0fdf4',
                  border: '1.5px solid #bbf7d0',
                  borderRadius: '10px',
                  padding: '12px 16px',
                }}>
                  <div style={{
                    fontSize: '0.8rem',
                    fontWeight: 700,
                    color: '#166534',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    marginBottom: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}>
                    <span>✓</span> Erhaltene & zugeordnete Zahlungen ({validMatchedTransactions.length || (effectiveStatus === 'PAID' ? 1 : 0)}):
                  </div>

                  {validMatchedTransactions.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {validMatchedTransactions.map((tx, idx) => (
                        <div
                          key={idx}
                          style={{
                            background: '#ffffff',
                            border: '1px solid #86efac',
                            borderRadius: '8px',
                            padding: '8px 12px',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{
                              fontSize: '0.68rem',
                              fontWeight: 700,
                              padding: '2px 8px',
                              borderRadius: '999px',
                              backgroundColor: tx.type === 'BANK' ? '#dbeafe' : tx.details?.toLowerCase().includes('paypal') ? '#e0f2fe' : tx.type === 'CARD' ? '#e0e7ff' : '#fce7f3',
                              color: tx.type === 'BANK' ? '#1e40af' : tx.details?.toLowerCase().includes('paypal') ? '#0284c7' : tx.type === 'CARD' ? '#3730a3' : '#9d174d',
                            }}>
                              {tx.type === 'BANK' ? 'Bank' : tx.details?.toLowerCase().includes('paypal') ? 'PayPal' : tx.type === 'CARD' ? 'Kartenterminal' : 'Booking.com'}
                            </span>
                            <div>
                              <div style={{ fontSize: '0.84rem', fontWeight: 600, color: '#0f172a' }}>
                                {tx.details}
                              </div>
                              <div style={{ fontSize: '0.72rem', color: '#64748b' }}>
                                Datum: {tx.date} • ID #{tx.id}
                              </div>
                            </div>
                          </div>
                          <div style={{ fontSize: '0.95rem', fontWeight: 800, color: '#166534', whiteSpace: 'nowrap', marginLeft: '12px' }}>
                            + {Number(tx.amount).toFixed(2)} €
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : effectiveStatus === 'PAID' ? (
                    <div style={{ fontSize: '0.84rem', color: '#166534', fontWeight: 600 }}>
                      Gesamter Betrag von {totalAmount.toFixed(2)} € ist vollständig bezahlt.
                    </div>
                  ) : (
                    <div style={{ fontSize: '0.82rem', color: '#64748b', fontStyle: 'italic' }}>
                      Bisher kein Geldeingang auf Bankkonto, Kartenterminal oder PayPal nachgewiesen (0,00 €).
                    </div>
                  )}
                </div>

                {/* Red/Amber Box: Ausstehende Forderung */}
                {openAmount > 0 ? (
                  <div style={{
                    background: '#fef2f2',
                    border: '1.5px solid #fecaca',
                    borderRadius: '10px',
                    padding: '12px 16px',
                  }}>
                    <div style={{
                      fontSize: '0.8rem',
                      fontWeight: 700,
                      color: '#991b1b',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      marginBottom: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}>
                      <span>⚠</span> Noch ausstehende Forderung ({openAmount.toFixed(2)} €):
                    </div>
                    
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {remainingExpectedByType.length > 0 ? (
                        remainingExpectedByType.map((item, idx: number) => (
                          <div
                            key={idx}
                            style={{
                              background: '#ffffff',
                              border: '1px solid #fca5a5',
                              borderRadius: '8px',
                              padding: '8px 12px',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                            }}
                          >
                            <div>
                              <div style={{ fontSize: '0.84rem', fontWeight: 600, color: '#991b1b' }}>
                                Erwartet laut Buchung: {fixEncoding(item.type)}
                              </div>
                              <div style={{ fontSize: '0.72rem', color: '#7f1d1d' }}>
                                🔍 Kein entsprechender Zahlungseingang auf dem Konto gefunden
                              </div>
                            </div>
                            <div style={{ fontSize: '0.95rem', fontWeight: 800, color: '#dc2626', whiteSpace: 'nowrap', marginLeft: '12px' }}>
                              - {item.amount.toFixed(2)} €
                            </div>
                          </div>
                        ))
                      ) : (
                        <div style={{
                          background: '#ffffff',
                          border: '1px solid #fca5a5',
                          borderRadius: '8px',
                          padding: '8px 12px',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}>
                          <div>
                            <div style={{ fontSize: '0.84rem', fontWeight: 600, color: '#991b1b' }}>
                              Restforderung offen: {openAmount.toFixed(2)} €
                            </div>
                            <div style={{ fontSize: '0.72rem', color: '#7f1d1d' }}>
                              🔍 Bisher kein passender Geldeingang im Bankauszug, Terminal oder PayPal vorhanden
                            </div>
                          </div>
                          <div style={{ fontSize: '0.95rem', fontWeight: 800, color: '#dc2626', whiteSpace: 'nowrap', marginLeft: '12px' }}>
                            - {openAmount.toFixed(2)} €
                          </div>
                        </div>
                      )}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#7f1d1d', marginTop: '8px', fontWeight: 500 }}>
                      ℹ️ Die Rechnung verbleibt im Status <strong>OFFEN / TEILZAHLUNG</strong> und wird nicht abgehakt.
                    </div>
                  </div>
                ) : (
                  <div style={{
                    background: '#f0fdf4',
                    border: '1.5px solid #86efac',
                    borderRadius: '10px',
                    padding: '10px 14px',
                    fontSize: '0.82rem',
                    color: '#15803d',
                    fontWeight: 600,
                  }}>
                    ✓ Keine offenen Restforderungen. Der Betrag ist zu 100% beglichen.
                  </div>
                )}
              </div>

              {/* 5. Detailed AI Explanation */}
              <div style={{
                background: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: '10px',
                padding: '12px 14px',
              }}>
                <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>
                  🤖 KI-Prüfbericht ({suggestion.headline}):
                </div>
                <p style={{ margin: 0, fontSize: '0.84rem', color: '#334155', lineHeight: 1.5 }}>
                  {suggestion.explanation}
                </p>
              </div>

              {/* 6. Suggested Comment for the [!] badge */}
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>
                  📌 KI-Hinweis (wird beim gelben [!] Symbol der Rechnung hinterlegt):
                </label>
                <input
                  type="text"
                  value={commentInput}
                  onChange={(e) => setCommentInput(e.target.value)}
                  placeholder="KI-Hinweis notieren..."
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    border: '1px solid #cbd5e1',
                    borderRadius: '6px',
                    fontSize: '0.85rem',
                    color: '#0f172a',
                    boxSizing: 'border-box',
                  }}
                />
                <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: '3px' }}>
                  💡 Dein manuelles Kommentarfeld bleibt unberührt. Dieser Text wird als Tooltip beim gelben [!] Symbol angezeigt.
                </div>
              </div>

              {/* 7. Collapsible Gemini API Key settings */}
              <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: '8px', marginTop: '2px' }}>
                <button
                  type="button"
                  onClick={() => setShowKeyConfig(!showKeyConfig)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: '#6366f1',
                    fontSize: '0.76rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  ⚙️ {showKeyConfig ? 'Gemini API-Key verbergen' : 'Gemini API-Key konfigurieren (optional)'}
                </button>
                {showKeyConfig && (
                  <div style={{ marginTop: '8px', padding: '10px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: '6px' }}>
                      Mit einem kostenlosen API-Key von <strong>Google AI Studio</strong> kann die KI auch komplexe Recherchen (z.B. Geschäftsführer von Firmen) durchführen.
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <input
                        type="password"
                        placeholder="AIzaSy..."
                        value={apiKey}
                        onChange={(e) => handleSaveApiKey(e.target.value)}
                        style={{
                          flex: 1,
                          padding: '6px 10px',
                          fontSize: '0.8rem',
                          border: '1px solid #cbd5e1',
                          borderRadius: '4px',
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => runInvestigation(apiKey)}
                        style={{
                          background: '#4f46e5',
                          color: 'white',
                          border: 'none',
                          padding: '6px 12px',
                          borderRadius: '4px',
                          fontSize: '0.78rem',
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        Neu analysieren
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer Actions */}
        <div style={{
          padding: '14px 24px',
          borderTop: '1px solid #f1f5f9',
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: '12px',
          background: '#f8fafc',
        }}>
          <button
            type="button"
            onClick={onClose}
            disabled={applying}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              border: '1px solid #cbd5e1',
              background: '#ffffff',
              color: '#334155',
              fontSize: '0.88rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Schließen
          </button>

          {suggestion && effectiveStatus === 'OPEN' && (
            <button
              type="button"
              onClick={handleSaveCommentOnly}
              disabled={applying}
              style={{
                padding: '8px 18px',
                borderRadius: '8px',
                border: '1px solid #cbd5e1',
                background: '#f1f5f9',
                color: '#334155',
                fontSize: '0.88rem',
                fontWeight: 600,
                cursor: applying ? 'not-allowed' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              {applying ? 'Wird gespeichert...' : '💾 KI-Hinweis [!] speichern (Rechnung bleibt offen)'}
            </button>
          )}

          {suggestion && effectiveStatus === 'PARTIAL' && (
            <button
              type="button"
              onClick={handleApply}
              disabled={applying}
              style={{
                padding: '8px 20px',
                borderRadius: '8px',
                border: 'none',
                background: '#d97706',
                color: '#ffffff',
                fontSize: '0.88rem',
                fontWeight: 600,
                cursor: applying ? 'not-allowed' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                boxShadow: '0 2px 4px rgba(217, 119, 6, 0.25)',
              }}
            >
              {applying
                ? 'Wird gespeichert...'
                : `✓ Teilzahlung (${paidAmount.toFixed(2)} €) erfassen – Rechnung bleibt mit ${openAmount.toFixed(2)} € offen`}
            </button>
          )}

          {suggestion && effectiveStatus === 'PAID' && (
            <button
              type="button"
              onClick={handleApply}
              disabled={applying}
              style={{
                padding: '8px 20px',
                borderRadius: '8px',
                border: 'none',
                background: '#16a34a',
                color: '#ffffff',
                fontSize: '0.88rem',
                fontWeight: 600,
                cursor: applying ? 'not-allowed' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                boxShadow: '0 2px 4px rgba(22, 163, 74, 0.25)',
              }}
            >
              {applying
                ? 'Wird gespeichert...'
                : `✓ Vollständig bezahlt (${totalAmount.toFixed(2)} €) & abhaken`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
