import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { api } from '../api';
import { Toast } from './Toast';
import type { ToastProps } from './Toast';

interface Invoice {
    id: number;
    invoiceDate: string;
    invoiceNumber: string;
    recipient: string;
    amount: number;
    paymentType: string;
    isReconciled: boolean;
    manualStatus: boolean;
    comment: string | null;
    matches?: any[];
    dunningStatus?: string;
    dunningMethod?: string;
    dunningDate?: string;
}

type SortField = 'date' | 'number' | 'recipient' | 'type' | 'amount' | 'status';
type SortDirection = 'asc' | 'desc';

export const Dashboard: React.FC = () => {
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sortField, setSortField] = useState<SortField>('date');
    const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
    const [toast, setToast] = useState<Omit<ToastProps, 'onClose'> | null>(null);
    const [importStatus, setImportStatus] = useState<Record<string, any[]>>({});

    const showToast = (message: string, type: 'success' | 'error' | 'info') => {
        setToast({ message, type });
    };

    const fetchInvoices = async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await api.getInvoices();
            if (Array.isArray(data)) {
                setInvoices(data);
            } else {
                console.error("Received invalid data:", data);
                setError("Failed to load invoices: Invalid data format");
            }
        } catch (e: any) {
            console.error(e);
            setError("Failed to connect to server");
        } finally {
            setLoading(false);
        }
    };

    const fetchImportStatus = async () => {
        try {
            const status = await api.getImportStatus();
            setImportStatus(status);
        } catch (e) {
            console.error('Failed to fetch import status:', e);
        }
    };

    useEffect(() => {
        fetchInvoices();
        fetchImportStatus();
    }, []);

    const handleReconcile = async () => {
        setLoading(true);
        try {
            const res = await api.reconcile();
            showToast(`Reconciliation complete! Matched: ${res.matches}`, 'success');
            fetchInvoices();
        } catch (e) {
            showToast('Reconciliation failed', 'error');
        } finally {
            setLoading(false);
        }
    };

    const handleSort = (field: SortField) => {
        if (sortField === field) {
            setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortDirection('asc');
        }
    };

    const handleCommentChange = useCallback((id: number, newComment: string) => {
        api.updateComment(id, newComment);
        setInvoices(prev => prev.map(i => i.id === id ? { ...i, comment: newComment } : i));
    }, []);

    const handleDunningUpdate = useCallback((id: number, status: string, method: string, date: string) => {
        api.updateDunning(id, status, method, date);
        setInvoices(prev => prev.map(i => i.id === id ? { ...i, dunningStatus: status, dunningMethod: method, dunningDate: date } : i));
    }, []);

    const toggleManual = useCallback(async (id: number, currentStatus: boolean) => {
        // Optimistic Update: Update UI immediately
        const newStatus = !currentStatus;
        setInvoices(prev => prev.map(i => i.id === id ? { ...i, manualStatus: newStatus, isReconciled: newStatus } : i));

        try {
            await api.toggleVerify(id, newStatus);
        } catch (e) {
            // Revert on failure
            showToast('Failed to update status', 'error');
            setInvoices(prev => prev.map(i => i.id === id ? { ...i, manualStatus: currentStatus, isReconciled: currentStatus } : i));
        }
    }, [showToast]);

    const sortInvoices = useCallback((invoicesToSort: Invoice[]): Invoice[] => {
        return [...invoicesToSort].sort((a, b) => {
            let aVal: any, bVal: any;

            switch (sortField) {
                case 'date':
                    aVal = new Date(a.invoiceDate).getTime();
                    bVal = new Date(b.invoiceDate).getTime();
                    break;
                case 'number':
                    aVal = a.invoiceNumber;
                    bVal = b.invoiceNumber;
                    break;
                case 'recipient':
                    aVal = a.recipient.toLowerCase();
                    bVal = b.recipient.toLowerCase();
                    break;
                case 'type':
                    aVal = a.paymentType.toLowerCase();
                    bVal = b.paymentType.toLowerCase();
                    break;
                case 'amount':
                    aVal = a.amount;
                    bVal = b.amount;
                    break;
                case 'status':
                    aVal = a.isReconciled ? 1 : (a.manualStatus ? 0.5 : 0);
                    bVal = b.isReconciled ? 1 : (b.manualStatus ? 0.5 : 0);
                    break;
                default:
                    return 0;
            }

            if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
            if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
            return 0;
        });
    }, [sortField, sortDirection]);

    // State for selected month
    const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('');

    // Filter invoices based on search term AND status filter
    const filteredInvoices = useMemo(() => {
        return invoices.filter(inv => {
            // 1. Status Filter
            if (statusFilter) {
                if (statusFilter === 'Open' && (inv.isReconciled || inv.manualStatus)) return false;
                if (statusFilter === 'Matched' && (!inv.isReconciled && !inv.manualStatus)) return false;
                if (statusFilter === 'Prüfen' && inv.dunningStatus !== 'Prüfen') return false;
                if (statusFilter === 'Reminder' && inv.dunningStatus !== 'Reminder') return false;
                if (statusFilter === 'Warning 1' && inv.dunningStatus !== 'Warning 1') return false;
                if (statusFilter === 'Warning 2' && inv.dunningStatus !== 'Warning 2') return false;
                if (statusFilter === 'Inkasso' && inv.dunningStatus !== 'Inkasso') return false;
            }

            // 2. Search Term
            if (!searchTerm) return true;
            const lowerTerm = searchTerm.toLowerCase();

            // Improved amount matching: allow "12,50" to match 12.50
            const amountStr = inv.amount.toFixed(2); // "12.50"
            const amountStrComma = amountStr.replace('.', ','); // "12,50"

            return (
                inv.invoiceNumber.toLowerCase().includes(lowerTerm) ||
                inv.recipient.toLowerCase().includes(lowerTerm) ||
                amountStr.includes(lowerTerm) ||
                amountStrComma.includes(lowerTerm) ||
                (inv.comment && inv.comment.toLowerCase().includes(lowerTerm))
            );
        });
    }, [invoices, searchTerm, statusFilter]);

    // Group by month (using filtered invoices) - ONLY used when NOT searching/filtering
    const groupedInvoices = useMemo(() => {
        const groups: { [key: string]: Invoice[] } = {};
        if (!searchTerm && !statusFilter) {
            filteredInvoices.forEach(inv => {
                const date = new Date(inv.invoiceDate);
                const monthKey = date.toLocaleDateString('de-DE', { year: 'numeric', month: 'long' });
                if (!groups[monthKey]) {
                    groups[monthKey] = [];
                }
                groups[monthKey].push(inv);
            });

            // Sort invoices within each month
            Object.keys(groups).forEach(month => {
                groups[month] = sortInvoices(groups[month]);
            });
        }
        return groups;
    }, [filteredInvoices, searchTerm, statusFilter, sortInvoices]);

    // Sort months chronologically
    const sortedMonths = useMemo(() => {
        return Object.keys(groupedInvoices).sort((a, b) => {
            const dateA = new Date(`1 ${a}`);
            const dateB = new Date(`1 ${b}`);
            return dateB.getTime() - dateA.getTime();
        });
    }, [groupedInvoices]);

    // Memoize the sorted list used for the "Search Results" view
    const sortedFilteredInvoices = useMemo(() => sortInvoices(filteredInvoices), [filteredInvoices, sortInvoices]);

    const getMatchDetails = (inv: Invoice): string => {
        if (!inv.matches || inv.matches.length === 0) return '';
        const match = inv.matches[0];

        if (match.bookingPayment) {
            return `Booking.com: ${match.bookingPayment.amount.toFixed(2)}€ (Ref: ${match.bookingPayment.referenceNumber})`;
        }
        if (match.cardPayment) {
            return `Card (${match.cardPayment.cardType}): ${match.cardPayment.amount.toFixed(2)}€ (${new Date(match.cardPayment.transactionDate).toLocaleDateString()})`;
        }
        if (match.bankTransaction) {
            return `Bank: ${match.bankTransaction.amount.toFixed(2)}€ (${match.bankTransaction.senderReceiver})`;
        }
        return "Matched";
    };

    const SortIcon: React.FC<{ field: SortField }> = ({ field }) => {
        if (sortField !== field) return <span style={{ opacity: 0.3 }}>↕</span>;
        return <span>{sortDirection === 'asc' ? '↑' : '↓'}</span>;
    };

    // Set default selected month when months change
    useEffect(() => {
        if (!searchTerm && !statusFilter && sortedMonths.length > 0) {
            if (!selectedMonth || !sortedMonths.includes(selectedMonth)) {
                setSelectedMonth(sortedMonths[0]);
            }
        } else if (!searchTerm && !statusFilter) {
            setSelectedMonth(null);
        }
    }, [sortedMonths, selectedMonth, searchTerm, statusFilter]);

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <h1>Invoices & Reconciliation</h1>
                    <input
                        type="text"
                        placeholder="Search invoices (Number, Name, Amount)..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        style={{
                            padding: '0.5rem 1rem',
                            borderRadius: '20px',
                            border: '1px solid var(--border)',
                            width: '300px',
                            fontSize: '0.9rem'
                        }}
                    />
                    <select
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}
                        style={{
                            padding: '0.5rem 1rem',
                            borderRadius: '20px',
                            border: '1px solid var(--border)',
                            fontSize: '0.9rem',
                            cursor: 'pointer',
                            backgroundColor: 'white'
                        }}
                    >
                        <option value="">All</option>
                        <option value="Open">Open</option>
                        <option value="Matched">Matched</option>
                        <option value="Prüfen">Prüfen</option>
                        <option value="Reminder">Reminder</option>
                        <option value="Warning 1">Warning 1</option>
                        <option value="Warning 2">Warning 2</option>
                        <option value="Inkasso">Inkasso</option>
                    </select>
                </div>
                <div style={{ display: 'flex', gap: '1rem' }}>
                    <button
                        className="btn"
                        onClick={async () => {
                            if (confirm('Are you sure you want to delete ALL data? This cannot be undone.')) {
                                setLoading(true);
                                try {
                                    await api.clearDatabase();
                                    showToast('Database cleared!', 'success');
                                    window.location.reload();
                                } catch (e) {
                                    showToast('Failed to clear database', 'error');
                                } finally {
                                    setLoading(false);
                                }
                            }
                        }}
                        style={{ backgroundColor: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}
                    >
                        Clear Database
                    </button>
                    <button className="btn btn-primary" onClick={handleReconcile} disabled={loading}>
                        {loading ? 'Processing...' : 'Run Reconciliation'}
                    </button>
                </div>
            </div>

            {error && (
                <div style={{ padding: '1rem', backgroundColor: '#fee2e2', color: '#991b1b', borderRadius: 'var(--radius)', marginBottom: '1rem' }}>
                    {error}
                </div>
            )}

            {/* Month Tabs - Hide when searching or filtering */}
            {/* Month Tabs - Hide when searching or filtering */}
            {!searchTerm && !statusFilter && (
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', overflowX: 'auto', paddingBottom: '0.5rem' }}>
                    {sortedMonths.map(month => {
                        const files = (importStatus as any)[month] || [];
                        const hasFiles = files.length > 0;
                        const fileListString = files.map((f: any) => `- ${f.originalName}`).join('\n');

                        return (
                            <button
                                key={month}
                                onClick={() => setSelectedMonth(month)}
                                title={fileListString} // Simple native tooltip
                                style={{
                                    padding: '0.75rem 1rem',
                                    borderRadius: 'var(--radius)',
                                    border: '1px solid var(--border)',
                                    backgroundColor: selectedMonth === month
                                        ? 'var(--primary)'
                                        : hasFiles
                                            ? '#d1fae5'
                                            : 'white',
                                    color: selectedMonth === month ? 'white' : 'inherit',
                                    cursor: 'pointer',
                                    whiteSpace: 'nowrap',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'center',
                                    gap: '0.25rem',
                                    minWidth: '100px',
                                    position: 'relative' // For custom tooltip if needed
                                }}
                            >
                                <div style={{ fontWeight: 'bold' }}>{month}</div>
                                {hasFiles && (
                                    <div style={{ fontSize: '0.7rem', opacity: 0.8 }}>
                                        {files.length} File{files.length !== 1 ? 's' : ''}
                                    </div>
                                )}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Content Area */}
            {(searchTerm || statusFilter) ? (
                // Search Results View (Flat List)
                <div style={{ marginBottom: '2rem' }}>
                    <h3 style={{ borderBottom: '2px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '1rem' }}>
                        Search Results ({filteredInvoices.length})
                    </h3>
                    <div className="card table-container">
                        <table>
                            <thead>
                                <tr>
                                    <th onClick={() => handleSort('date')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                                        Date <SortIcon field="date" />
                                    </th>
                                    <th onClick={() => handleSort('number')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                                        Number <SortIcon field="number" />
                                    </th>
                                    <th onClick={() => handleSort('recipient')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                                        Recipient <SortIcon field="recipient" />
                                    </th>
                                    <th onClick={() => handleSort('type')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                                        Type <SortIcon field="type" />
                                    </th>
                                    <th onClick={() => handleSort('amount')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                                        Amount <SortIcon field="amount" />
                                    </th>
                                    <th onClick={() => handleSort('status')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                                        Status <SortIcon field="status" />
                                    </th>
                                    <th>Manual</th>
                                    <th>Comment</th>
                                </tr>
                            </thead>
                            <tbody>
                                {sortedFilteredInvoices.map((inv) => (
                                    <InvoiceRow
                                        key={inv.id}
                                        inv={inv}
                                        onToggleManual={toggleManual}
                                        onCommentChange={handleCommentChange}
                                        onDunningUpdate={handleDunningUpdate}
                                        getMatchDetails={getMatchDetails}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            ) : (
                // Month View
                selectedMonth && groupedInvoices[selectedMonth] && (
                    <div key={selectedMonth} style={{ marginBottom: '2rem' }}>
                        <h3 style={{ borderBottom: '2px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '1rem' }}>{selectedMonth}</h3>
                        <div className="card table-container">
                            <table>
                                <thead>
                                    <tr>
                                        <th onClick={() => handleSort('date')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                                            Date <SortIcon field="date" />
                                        </th>
                                        <th onClick={() => handleSort('number')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                                            Number <SortIcon field="number" />
                                        </th>
                                        <th onClick={() => handleSort('recipient')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                                            Recipient <SortIcon field="recipient" />
                                        </th>
                                        <th onClick={() => handleSort('type')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                                            Type <SortIcon field="type" />
                                        </th>
                                        <th onClick={() => handleSort('amount')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                                            Amount <SortIcon field="amount" />
                                        </th>
                                        <th onClick={() => handleSort('status')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                                            Status <SortIcon field="status" />
                                        </th>
                                        <th>Manual</th>
                                        <th>Comment / Dunning</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {groupedInvoices[selectedMonth].map((inv) => (
                                        <InvoiceRow
                                            key={inv.id}
                                            inv={inv}
                                            onToggleManual={toggleManual}
                                            onCommentChange={handleCommentChange}
                                            onDunningUpdate={handleDunningUpdate}
                                            getMatchDetails={getMatchDetails}
                                        />
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )
            )}
            {toast && <Toast {...toast} onClose={() => setToast(null)} />}
        </div>
    );
};

interface InvoiceRowProps {
    inv: Invoice;
    onToggleManual: (id: number, currentStatus: boolean) => void;
    onCommentChange: (id: number, comment: string) => void;
    onDunningUpdate: (id: number, status: string, method: string, date: string) => void;
    getMatchDetails: (inv: Invoice) => string;
}

const InvoiceRow: React.FC<InvoiceRowProps> = React.memo(({ inv, onToggleManual, onCommentChange, onDunningUpdate, getMatchDetails }) => {
    // Optimistic UI State
    const [optimisticManualStatus, setOptimisticManualStatus] = useState(inv.manualStatus);
    const [optimisticIsReconciled, setOptimisticIsReconciled] = useState(inv.isReconciled);

    // Sync with props when they change (e.g. after refresh or initial load)
    useEffect(() => {
        setOptimisticManualStatus(inv.manualStatus);
        setOptimisticIsReconciled(inv.isReconciled);
    }, [inv.manualStatus, inv.isReconciled]);

    const handleToggle = () => {
        // 1. Immediate Visual Feedback
        const newStatus = !optimisticManualStatus; // Toggle based on current optimistic state
        setOptimisticManualStatus(newStatus);
        setOptimisticIsReconciled(newStatus); // Assuming manual toggle sets reconciled to same value as logic in Dashboard

        // 2. Defer heavy update
        React.startTransition(() => {
            onToggleManual(inv.id, optimisticManualStatus || optimisticIsReconciled);
        });
    };

    // Determine Row Color using Optimistic State
    let rowColor = 'transparent';
    let textColor = 'inherit';

    if (optimisticIsReconciled || optimisticManualStatus) {
        rowColor = '#bbf7d0'; // Green (Reconciled)
    } else if (inv.dunningStatus === 'Inkasso') {
        rowColor = '#000000'; // Black
        textColor = '#ffffff';
    } else if (inv.dunningStatus === 'Warning 2') {
        rowColor = '#7f1d1d'; // Dark Red
        textColor = '#ffffff';
    } else if (inv.dunningStatus === 'Warning 1') {
        rowColor = '#fca5a5'; // Red
    } else if (inv.dunningStatus === 'Reminder') {
        rowColor = '#fef3c7'; // Yellow
    } else if (inv.dunningStatus === 'Prüfen') {
        rowColor = '#d1d5db'; // Gray
    }

    return (
        <tr style={{ backgroundColor: rowColor, color: textColor }}>
            <td>{new Date(inv.invoiceDate).toLocaleDateString('de-DE')}</td>
            <td>{inv.invoiceNumber}</td>
            <td>{inv.recipient}</td>
            <td>{inv.paymentType}</td>
            <td>{inv.amount.toFixed(2)} €</td>
            <td>
                <div className="tooltip-container">
                    <span className={`status-badge ${optimisticIsReconciled ? 'status-matched' : optimisticManualStatus ? 'status-manual' : 'status-open'}`}>
                        {optimisticIsReconciled ? (inv.matches && inv.matches.length > 0 ? 'Matched' : 'Manual') : 'Open'}
                    </span>
                    {(optimisticIsReconciled || optimisticManualStatus) && (
                        <div className="tooltip">
                            {inv.matches && inv.matches.length > 0 ? getMatchDetails(inv) : 'Manuell zugeordnet'}
                        </div>
                    )}
                </div>
            </td>
            <td>
                <input
                    type="checkbox"
                    checked={optimisticIsReconciled || optimisticManualStatus}
                    onChange={handleToggle}
                />
            </td>
            <td>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <input
                        type="text"
                        value={inv.comment || ''}
                        onChange={(e) => onCommentChange(inv.id, e.target.value)}
                        placeholder="Kommentar..."
                        style={{ width: '100%', padding: '0.25rem', border: '1px solid var(--border)', borderRadius: '4px', fontSize: '0.8rem', color: 'black' }}
                    />
                    {/* Dunning / Reminder Controls */}
                    <div style={{ display: 'flex', gap: '0.25rem' }}>
                        <select
                            value={inv.dunningStatus || ''}
                            onChange={(e) => onDunningUpdate(inv.id, e.target.value, inv.dunningMethod || 'Email', inv.dunningDate || new Date().toISOString())}
                            style={{ fontSize: '0.75rem', padding: '0.1rem', borderRadius: '3px', border: '1px solid #ccc', maxWidth: '80px', color: 'black' }}
                        >
                            <option value="">- Status -</option>
                            <option value="Prüfen">Prüfen</option>
                            <option value="Reminder">Erinnerung</option>
                            <option value="Warning 1">Mahnung 1</option>
                            <option value="Warning 2">Mahnung 2</option>
                            <option value="Inkasso">Inkasso</option>
                        </select>
                        {inv.dunningStatus && (
                            <>
                                <select
                                    value={inv.dunningMethod || 'Email'}
                                    onChange={(e) => onDunningUpdate(inv.id, inv.dunningStatus!, e.target.value, inv.dunningDate!)}
                                    style={{ fontSize: '0.75rem', padding: '0.1rem', borderRadius: '3px', border: '1px solid #ccc', maxWidth: '60px', color: 'black' }}
                                >
                                    <option value="Email">Email</option>
                                    <option value="Post">Post</option>
                                </select>
                                <input
                                    type="date"
                                    value={inv.dunningDate ? new Date(inv.dunningDate).toISOString().split('T')[0] : ''}
                                    onChange={(e) => onDunningUpdate(inv.id, inv.dunningStatus!, inv.dunningMethod!, e.target.value)}
                                    style={{ fontSize: '0.75rem', padding: '0.1rem', borderRadius: '3px', border: '1px solid #ccc', width: '80px', color: 'black' }}
                                />
                            </>
                        )}
                    </div>
                </div>
            </td>
        </tr>
    );
});
