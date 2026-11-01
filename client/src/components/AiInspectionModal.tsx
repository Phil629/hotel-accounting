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

  const runInvestigation = async () => {
    if (!invoice) return;
    setLoading(true);
    setError(null);
    setSuggestion(null);

    try {
      const res = await api.checkInvoiceWithAI(invoice.id, apiKey || undefined);
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

  const handleSaveApiKey = (newKey: string) => {
    setApiKey(newKey);
    localStorage.setItem('GEMINI_API_KEY', newKey);
  };

  const handleSaveCommentOnly = async () => {
    if (!invoice) return;
    setApplying(true);
    setError(null);

    try {
      await api.updateComment(invoice.id, commentInput);
      onApplied(invoice.id, 'OPEN', Number(invoice.amount), commentInput);
      onClose();
    } catch (e: any) {
      setError(e.message || 'Konnte den Kommentar nicht speichern.');
    } finally {
      setApplying(false);
    }
  };

  const handleApply = async () => {
    if (!suggestion) return;
    setApplying(true);
    setError(null);

    try {
      await api.applyAiMatch(invoice.id, {
        status: suggestion.status,
        amountPaid: suggestion.amount,
        comment: commentInput,
        matches: suggestion.matchedTransactions.map(t => ({
          type: t.type,
          id: t.id,
        })),
      });

      onApplied(invoice.id, suggestion.status, suggestion.amount, commentInput);
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
        maxWidth: '620px',
        maxHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
        overflow: 'hidden',
        border: '1px solid #e2e8f0',
      }}>
        {/* Header */}
        <div style={{
          padding: '20px 24px',
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
              <strong>{invoice.recipient}</strong> • {Number(invoice.amount).toFixed(2)} € • {new Date(invoice.invoiceDate).toLocaleDateString('de-DE')}
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
        <div style={{ padding: '24px', overflowY: 'auto', flex: 1 }}>
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
              border: '1px solid #fecaca',
              borderRadius: '8px',
              padding: '12px 16px',
              color: '#991b1b',
              fontSize: '0.9rem',
              marginBottom: '16px',
            }}>
              <strong>Fehler:</strong> {error}
              <div style={{ marginTop: '8px' }}>
                <button
                  onClick={runInvestigation}
                  style={{
                    background: '#ef4444',
                    color: 'white',
                    border: 'none',
                    padding: '4px 10px',
                    borderRadius: '4px',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                  }}
                >
                  Erneut versuchen
                </button>
              </div>
            </div>
          )}

          {!loading && suggestion && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Status Banner */}
              <div style={{
                padding: '14px 16px',
                borderRadius: '10px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                backgroundColor: suggestion.status === 'PAID' ? '#f0fdf4' : suggestion.status === 'PARTIAL' ? '#fffbeb' : '#fef2f2',
                border: `1.5px solid ${suggestion.status === 'PAID' ? '#86efac' : suggestion.status === 'PARTIAL' ? '#fde68a' : '#fecaca'}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '1.4rem' }}>
                    {suggestion.status === 'PAID' ? '🟢' : suggestion.status === 'PARTIAL' ? '🟡' : '🔴'}
                  </span>
                  <div>
                    <div style={{
                      fontWeight: 700,
                      fontSize: '0.95rem',
                      color: suggestion.status === 'PAID' ? '#166534' : suggestion.status === 'PARTIAL' ? '#92400e' : '#991b1b',
                    }}>
                      {suggestion.status === 'PAID'
                        ? 'VOLLSTÄNDIG BEZAHLT GEFUNDEN'
                        : suggestion.status === 'PARTIAL'
                        ? 'TEILZAHLUNG GEFUNDEN'
                        : 'KEIN GELDEINGANG GEFUNDEN (OFFEN)'}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                      Konfidenz: {Math.round(suggestion.confidence * 100)}% {suggestion.geminiUsed && '• Mit Gemini AI'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Headline & Explanation */}
              <div style={{
                background: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: '10px',
                padding: '16px',
              }}>
                <h4 style={{ margin: '0 0 8px 0', fontSize: '0.95rem', color: '#1e293b' }}>
                  {suggestion.headline}
                </h4>
                <p style={{ margin: 0, fontSize: '0.88rem', color: '#334155', lineHeight: 1.55 }}>
                  {suggestion.explanation}
                </p>
              </div>

              {/* Matched Transactions List */}
              {suggestion.matchedTransactions && suggestion.matchedTransactions.length > 0 && (
                <div>
                  <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
                    Gefundene Zahlungsnachweise ({suggestion.matchedTransactions.length}):
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {suggestion.matchedTransactions.map((tx, idx) => (
                      <div
                        key={idx}
                        style={{
                          background: '#ffffff',
                          border: '1px solid #cbd5e1',
                          borderRadius: '8px',
                          padding: '10px 14px',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <span style={{
                            fontSize: '0.7rem',
                            fontWeight: 700,
                            padding: '2px 8px',
                            borderRadius: '999px',
                            backgroundColor: tx.type === 'BANK' ? '#dbeafe' : tx.type === 'CARD' ? '#e0e7ff' : '#fce7f3',
                            color: tx.type === 'BANK' ? '#1e40af' : tx.type === 'CARD' ? '#3730a3' : '#9d174d',
                          }}>
                            {tx.type === 'BANK' ? 'Bank' : tx.type === 'CARD' ? 'Kartenterminal' : 'Booking.com'}
                          </span>
                          <div>
                            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#0f172a' }}>
                              {tx.details}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                              Datum: {tx.date} • ID #{tx.id}
                            </div>
                          </div>
                        </div>
                        <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#166534', whiteSpace: 'nowrap', marginLeft: '12px' }}>
                          {Number(tx.amount).toFixed(2)} €
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Suggested Comment */}
              <div>
                <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>
                  Kommentar für die Rechnung (wird beim Abhaken gespeichert):
                </label>
                <input
                  type="text"
                  value={commentInput}
                  onChange={(e) => setCommentInput(e.target.value)}
                  placeholder="Kommentar..."
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
              </div>

              {/* Collapsible Gemini API Key settings */}
              <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: '10px', marginTop: '4px' }}>
                <button
                  type="button"
                  onClick={() => setShowKeyConfig(!showKeyConfig)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: '#6366f1',
                    fontSize: '0.78rem',
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
                        onClick={runInvestigation}
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
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div style={{
          padding: '16px 24px',
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

          {suggestion && suggestion.status === 'OPEN' && (
            <button
              type="button"
              onClick={handleSaveCommentOnly}
              disabled={applying}
              style={{
                padding: '8px 18px',
                borderRadius: '8px',
                border: '1px solid #cbd5e1',
                background: '#f8fafc',
                color: '#334155',
                fontSize: '0.88rem',
                fontWeight: 600,
                cursor: applying ? 'not-allowed' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              {applying ? 'Wird gespeichert...' : '💾 Notiz übernehmen'}
            </button>
          )}

          {suggestion && suggestion.status !== 'OPEN' && (
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
              {applying ? 'Wird gespeichert...' : '✓ Vorschlag übernehmen & Rechnung abhaken'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
