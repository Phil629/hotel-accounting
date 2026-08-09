import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { api, API_URL } from '../api';
import { Toast } from './Toast';
import type { ToastProps } from './Toast';

interface RoomReservation {
    id: number;
    guestName: string;
    checkIn: string;
    checkOut: string;
    days: number;
    pax: number;
    totalPrice: number;
    cityTax?: number;
    isAirbnb: boolean;
}

interface PmsPayment {
    id: number;
    paymentType: string;
    amount: number;
    paymentDate: string;
}

interface Invoice {
    id: number;
    invoiceDate: string;
    invoiceNumber: string;
    recipient: string;
    amount: number;
    amountPaid: number;
    status: 'OPEN' | 'PARTIAL' | 'PAID';
    paymentType: string;
    isReconciled: boolean;
    manualStatus: boolean;
    comment: string | null;
    matches?: any[];
    pmsPayments?: PmsPayment[];
    roomReservations?: RoomReservation[];
    dunningStatus?: string;
    dunningMethod?: string;
    dunningDate?: string;
    tax7Amount?: number;
    tax19Amount?: number;
    cityTaxAmount?: number;
    netAmount?: number;
}



type SortField = 'date' | 'number' | 'recipient' | 'type' | 'amount' | 'status';
type SortDirection = 'asc' | 'desc';

// Helper: convert German locale month name ("November 2025") to YYYY-MM string
const monthNameToYYYYMM = (monthName: string): string => {
    const d = new Date(`1 ${monthName}`);
    if (!isNaN(d.getTime())) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    const months: Record<string, string> = {
        'Januar': '01', 'Februar': '02', 'März': '03', 'April': '04',
        'Mai': '05', 'Juni': '06', 'Juli': '07', 'August': '08',
        'September': '09', 'Oktober': '10', 'November': '11', 'Dezember': '12'
    };
    const parts = monthName.split(' ');
    const month = months[parts[0]];
    const year = parts[1];
    return month && year ? `${year}-${month}` : '';
};

export const Dashboard: React.FC = () => {
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [loading, setLoading] = useState(false);
    const [reconciling, setReconciling] = useState(false);
    const [progress, setProgress] = useState(0);
    const [progressText, setProgressText] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [sortField, setSortField] = useState<SortField>('date');
    const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
    const [toast, setToast] = useState<Omit<ToastProps, 'onClose'> | null>(null);
    const [importStatus, setImportStatus] = useState<Record<string, any[]>>({});
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [selectedMonthsToDelete, setSelectedMonthsToDelete] = useState<Set<string>>(new Set());
    const [deleting, setDeleting] = useState(false);

    const [fullyLoadedMonths, setFullyLoadedMonths] = useState<Set<string>>(() => {
        const defaultLoaded = new Set<string>();
        for (let i = 0; i < 4; i++) {
            const d = new Date();
            d.setMonth(d.getMonth() - i);
            defaultLoaded.add(d.toLocaleDateString('de-DE', { year: 'numeric', month: 'long' }));
        }
        return defaultLoaded;
    });

    const showToast = (message: string, type: 'success' | 'error' | 'info') => {
        setToast({ message, type });
    };

    const fetchInvoices = async (monthsToLoad?: Set<string>) => {
        setLoading(true);
        setError(null);
        try {
            const currentLoaded = monthsToLoad || fullyLoadedMonths;
            const monthsParam = Array.from(currentLoaded).map(monthNameToYYYYMM).filter(Boolean);
            const data = await api.getInvoices(monthsParam);
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
        setReconciling(true);
        setProgress(0);
        setProgressText('Verbinde mit Server... Bitte das Fenster nicht schließen, dieser Vorgang kann einen Moment dauern.');

        const eventSource = new EventSource(`${API_URL}/progress/stream`);

        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                setProgress(data.progress);
                setProgressText(data.message);
            } catch (err) {}
        };

        // Give the SSE connection a moment to establish before blocking the server
        await new Promise(r => setTimeout(r, 1000));

        try {
            const res = await api.reconcile();
            showToast(`Abgleich abgeschlossen! ${res.matches} Rechnungen zugeordnet.`, 'success');
            fetchInvoices();
        } catch (e) {
            showToast('Abgleich fehlgeschlagen', 'error');
        } finally {
            eventSource.close();
            setReconciling(false);
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
        api.updateComment(id, newComment).catch(e => {
            console.error('Failed to update comment:', e);
            showToast('Fehler beim Speichern des Kommentars', 'error');
        });
        setInvoices(prev => prev.map(i => i.id === id ? { ...i, comment: newComment } : i));
    }, []);

    const handleDunningUpdate = useCallback((id: number, status: string, method: string, date: string) => {
        api.updateDunning(id, status, method, date).catch(e => {
            console.error('Failed to update dunning:', e);
            showToast('Fehler beim Speichern der Mahnung', 'error');
        });
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
                    aVal = Number(a.amount);
                    bVal = Number(b.amount);
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
            const amountStr = Number(inv.amount).toFixed(2); // "12.50"
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

    // Group by month (using filtered invoices) - ONLY used when NOT searching
    const groupedInvoices = useMemo(() => {
        const groups: { [key: string]: Invoice[] } = {};
        if (!searchTerm) {
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
    }, [filteredInvoices, searchTerm, sortInvoices]);

    // Sort months chronologically
    const sortedMonths = useMemo(() => {
        const allMonths = new Set([...Object.keys(groupedInvoices), ...Object.keys(importStatus)]);
        return Array.from(allMonths).sort((a, b) => {
            const dateA = new Date(monthNameToYYYYMM(a) + "-01");
            const dateB = new Date(monthNameToYYYYMM(b) + "-01");
            return dateB.getTime() - dateA.getTime();
        });
    }, [groupedInvoices, importStatus]);

    // Compute per-month reconciliation status
    const monthStatus = useMemo(() => {
        const result: Record<string, { total: number; open: number; openSum: number; closedSum: number; allDone: boolean }> = {};
        for (const month of Object.keys(groupedInvoices)) {
            const invs = groupedInvoices[month];
            const open = invs.filter(i => !i.isReconciled && !i.manualStatus);
            const closed = invs.filter(i => i.isReconciled || i.manualStatus);

            const openSum = open.reduce((sum, i) => sum + Number(i.amount), 0);
            const closedSum = closed.reduce((sum, i) => sum + Number(i.amount), 0);

            result[month] = {
                total: invs.length,
                open: open.length,
                openSum,
                closedSum,
                allDone: open.length === 0
            };
        }
        return result;
    }, [groupedInvoices]);

    const citytaxStats = useMemo(() => {
        let generated = 0;
        let paid = 0;
        
        if (selectedMonth && groupedInvoices[selectedMonth]) {
            for (const inv of groupedInvoices[selectedMonth]) {
                let invTax = Number(inv.cityTaxAmount || 0);
                generated += invTax;
                
                if (inv.status === 'PAID' || inv.isReconciled || inv.manualStatus) {
                    paid += invTax;
                } else if (inv.status === 'PARTIAL' && Number(inv.amount) > 0) {
                    paid += invTax * (Number(inv.amountPaid) / Number(inv.amount));
                }
            }
        }
        return { generated, paid };
    }, [selectedMonth, groupedInvoices]);

    // Delete selected months
    const handleDeleteMonths = async () => {
        if (selectedMonthsToDelete.size === 0) return;
        
        setDeleting(true);
        try {
            for (const month of selectedMonthsToDelete) {
                const yyyymm = monthNameToYYYYMM(month);
                await api.deleteMonth(yyyymm);
            }
            showToast(`${selectedMonthsToDelete.size} Monat(e) gelöscht.`, 'success');
            setShowDeleteModal(false);
            setSelectedMonthsToDelete(new Set());
            fetchInvoices();
            fetchImportStatus();
        } catch (e) {
            showToast('Löschen fehlgeschlagen', 'error');
        } finally {
            setDeleting(false);
        }
    };

    // Memoize the sorted list used for the "Search Results" view
    const sortedFilteredInvoices = useMemo(() => sortInvoices(filteredInvoices), [filteredInvoices, sortInvoices]);

    const getMatchDetails = (inv: Invoice): string => {
        let details = '';
        
        let totalCityTax = Number(inv.cityTaxAmount || 0);
        
        details += `Rechnungsbetrag: ${Number(inv.amount).toFixed(2)} €\n`;
        if (totalCityTax > 0) {
            details += `Davon Citytax: ${totalCityTax.toFixed(2)} €\n`;
        }
        
        if (inv.pmsPayments && inv.pmsPayments.length > 0) {
            details += `\nZahlung (Hotelsoftware):\n`;
            inv.pmsPayments.forEach(p => {
                details += `- ${p.paymentType}: ${Number(p.amount).toFixed(2)} €\n`;
            });
        }
        
        if (inv.matches && inv.matches.length > 0) {
            details += `\nBank-Abgleich:\n`;
            inv.matches.forEach(match => {
                const isSuggestion = match.matchType === 'SUGGESTED_MISMATCH';
                const prefix = isSuggestion ? 'Vorschlag: ' : '';
        
                if (match.bookingPayment) {
                    details += `- ${prefix}Booking.com: ${Number(match.bookingPayment.amount).toFixed(2)} €\n`;
                }
                if (match.cardPayment) {
                    details += `- ${prefix}Card (${match.cardPayment.cardType}): ${Number(match.cardPayment.amount).toFixed(2)} €\n`;
                }
                if (match.bankTransaction) {
                    details += `- ${prefix}Bank: ${Number(match.bankTransaction.amount).toFixed(2)} €\n`;
                }
            });
        }

        if (!inv.pmsPayments?.length && (!inv.matches || inv.matches.length === 0)) {
            details += `\n(Keine Zahlungsdetails gefunden)`;
        }

        return details.trim();
    };



    const SortIcon: React.FC<{ field: SortField }> = ({ field }) => {
        if (sortField !== field) return <span style={{ opacity: 0.3 }}>↕</span>;
        return <span>{sortDirection === 'asc' ? '↑' : '↓'}</span>;
    };

    const handleMonthClick = async (month: string) => {
        setSelectedMonth(month);
        if (!fullyLoadedMonths.has(month)) {
            const newFullyLoaded = new Set(fullyLoadedMonths);
            newFullyLoaded.add(month);
            setFullyLoadedMonths(newFullyLoaded);
            await fetchInvoices(newFullyLoaded);
        }
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
                        <option value="Prüfen">Dunning: Prüfen</option>
                        <option value="Reminder">Dunning: Reminder</option>
                        <option value="Warning 1">Dunning: Warning 1</option>
                        <option value="Warning 2">Dunning: Warning 2</option>
                        <option value="Inkasso">Dunning: Inkasso</option>
                    </select>
                </div>
                <div style={{ display: 'flex', gap: '1rem' }}>
                    <button className="btn"
                        onClick={async () => {
                            try {
                                showToast('Backup wird generiert...', 'info');
                                const data = await api.downloadBackup();
                                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                                const url = window.URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = `hotel-accounting-backup-${new Date().toISOString().split('T')[0]}.json`;
                                document.body.appendChild(a);
                                a.click();
                                window.URL.revokeObjectURL(url);
                                document.body.removeChild(a);
                                showToast('Backup erfolgreich heruntergeladen!', 'success');
                            } catch (e) {
                                showToast('Backup fehlgeschlagen', 'error');
                            }
                        }}
                        style={{ backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db' }}
                    >
                        Backup laden
                    </button>
                    <button
                        className="btn"
                        onClick={() => setShowDeleteModal(true)}
                        style={{ backgroundColor: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}
                    >
                        Monat löschen
                    </button>
                    <button className="btn btn-primary" onClick={handleReconcile} disabled={reconciling || loading}>
                        {reconciling ? 'Läuft...' : 'Abgleich starten'}
                    </button>
                </div>
            </div>

            {error && (
                <div style={{ padding: '1rem', backgroundColor: '#fee2e2', color: '#991b1b', borderRadius: 'var(--radius)', marginBottom: '1rem' }}>
                    {error}
                </div>
            )}

            {/* Month Tabs - Hide when searching */}
            {!searchTerm && (
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', overflowX: 'auto', paddingBottom: '0.5rem' }}>
                    {sortedMonths.map(month => {
                        const files = (importStatus as any)[month] || [];
                        const hasFiles = files.length > 0;
                        const fileListString = files.map((f: any) => `- ${f.originalName}`).join('\n');
                        const ms = monthStatus[month];
                        const allDone = ms?.allDone ?? false;
                        const isFullyLoaded = fullyLoadedMonths.has(month);

                        // Wenn der Monat nicht vollständig geladen ist und keine Rechnungen vom Backend 
                        // für diesen Monat mitgeschickt wurden (ms ist undefined), bedeutet das, 
                        // dass es keine offenen Rechnungen gibt (da diese immer geladen werden).
                        const assumedAllDone = allDone || (!isFullyLoaded && !ms);

                        const bgColor = selectedMonth === month
                            ? 'var(--primary)'
                            : assumedAllDone && hasFiles
                                ? '#bbf7d0'   // green: all reconciled
                                : hasFiles
                                    ? '#fef3c7' // yellow: files uploaded but open invoices
                                    : 'white';  // white: no files

                        return (
                            <button
                                key={month}
                                onClick={() => handleMonthClick(month)}
                                title={fileListString}
                                style={{
                                    padding: '0.75rem 1rem',
                                    borderRadius: 'var(--radius)',
                                    border: '1px solid var(--border)',
                                    backgroundColor: bgColor,
                                    color: selectedMonth === month ? 'white' : 'inherit',
                                    cursor: 'pointer',
                                    whiteSpace: 'nowrap',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'center',
                                    gap: '0.25rem',
                                    minWidth: '100px',
                                }}
                            >
                                <div style={{ fontWeight: 'bold' }}>{month}</div>
                                {!isFullyLoaded ? (
                                    <div style={{ fontSize: '0.7rem', opacity: 0.85 }}>
                                        (zum laden klicken)
                                    </div>
                                ) : ms ? (
                                    <div style={{ fontSize: '0.7rem', opacity: 0.85 }}>
                                        {ms.allDone
                                            ? '✅ Vollständig'
                                            : `${ms.open} offen`}
                                    </div>
                                ) : (
                                    <div style={{ fontSize: '0.7rem', opacity: 0.85 }}>
                                        Keine Rechnungen
                                    </div>
                                )}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Content Area */}
            {searchTerm ? (
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
                selectedMonth && (
                    <div key={selectedMonth} style={{ marginBottom: '2rem' }}>
                        <h3 style={{ borderBottom: '2px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '0.75rem' }}>{selectedMonth}</h3>
                        
                        {groupedInvoices[selectedMonth] ? (
                            <>
                                {/* Monthly Summary Bar */}
                                {monthStatus[selectedMonth] && (
                                    <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '1rem' }}>
                                        <div style={{
                                            flex: 1, display: 'flex', gap: '1.5rem',
                                            padding: '0.6rem 1rem', borderRadius: 'var(--radius)',
                                            backgroundColor: monthStatus[selectedMonth].allDone ? '#d1fae5' : '#fef9c3',
                                            border: `1px solid ${monthStatus[selectedMonth].allDone ? '#6ee7b7' : '#fde047'}`,
                                            fontSize: '0.9rem'
                                        }}>
                                            <span>📄 <strong>{monthStatus[selectedMonth].total}</strong> Rechnungen gesamt</span>
                                            <span style={{ color: '#065f46' }}>✅ <strong>{monthStatus[selectedMonth].total - monthStatus[selectedMonth].open}</strong> abgeglichen — Summe: <strong>{monthStatus[selectedMonth].closedSum.toFixed(2)} €</strong></span>
                                            {monthStatus[selectedMonth].open > 0 && (
                                                <span style={{ color: '#b45309' }}>⚠️ <strong>{monthStatus[selectedMonth].open}</strong> offen — Summe: <strong>{monthStatus[selectedMonth].openSum.toFixed(2)} €</strong></span>
                                            )}
                                            {monthStatus[selectedMonth].allDone && <span>🎉 Monat vollständig abgeglichen!</span>}
                                        </div>

                                        <div style={{
                                            display: 'flex', gap: '1.5rem',
                                            padding: '0.6rem 1rem', borderRadius: 'var(--radius)',
                                            backgroundColor: '#eff6ff',
                                            border: `1px solid #bfdbfe`,
                                            fontSize: '0.9rem'
                                        }}>
                                            <span>🏛️ <strong>Citytax Dashboard</strong></span>
                                            <span style={{ color: '#1e40af' }}>Generiert: <strong>{citytaxStats.generated.toFixed(2)} €</strong></span>
                                            <span style={{ color: '#047857' }}>Bezahlt: <strong>{citytaxStats.paid.toFixed(2)} €</strong></span>
                                            {citytaxStats.generated > citytaxStats.paid && (
                                                <span style={{ color: '#b45309' }}>Offen: <strong>{(citytaxStats.generated - citytaxStats.paid).toFixed(2)} €</strong></span>
                                            )}
                                        </div>
                                    </div>
                                )}
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
                            </>
                        ) : (
                            <div style={{ padding: '3rem', textAlign: 'center', backgroundColor: '#f9fafb', borderRadius: 'var(--radius)', border: '1px dashed #d1d5db', color: '#6b7280' }}>
                                Für diesen Monat wurden (noch) keine Rechnungen hochgeladen. Bitte lade zunächst eine XML-Datei mit den offenen Rechnungen in der Hotelsoftware hoch.
                            </div>
                        )}
                    </div>
                )
            )}

            {/* Reconciliation Blocking Overlay */}
            {reconciling && (
                <div style={{
                    position: 'fixed', inset: 0,
                    backgroundColor: 'rgba(0,0,0,0.7)',
                    zIndex: 9999,
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center',
                    gap: '1.5rem', color: 'white'
                }}>
                    <h2 style={{ margin: 0, fontSize: '1.8rem' }}>Rechnungsabgleich läuft</h2>
                    <div style={{ width: '400px', backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: '8px', overflow: 'hidden' }}>
                        <div style={{
                            width: `${progress}%`,
                            height: '12px',
                            backgroundColor: '#10b981',
                            transition: 'width 0.3s ease'
                        }} />
                    </div>
                    <div style={{ fontSize: '1.1rem', fontWeight: '500' }}>
                        {progress}% – {progressText}
                    </div>
                </div>
            )}

            {/* Month Deletion Modal */}
            {showDeleteModal && (
                <div style={{
                    position: 'fixed', inset: 0,
                    backgroundColor: 'rgba(0,0,0,0.5)',
                    zIndex: 9998,
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}>
                    <div className="card" style={{ minWidth: '320px', maxWidth: '480px', padding: '1.5rem' }}>
                        <h3 style={{ marginBottom: '1rem' }}>Monat(e) löschen</h3>
                        <p style={{ marginBottom: '1rem', fontSize: '0.9rem', color: '#6b7280' }}>
                            Wähle die Monate aus, die gelöscht werden sollen. Alle Rechnungen, Abgleiche und hochgeladenen Dateien des Monats werden entfernt.
                        </p>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.5rem', maxHeight: '300px', overflowY: 'auto' }}>
                            {sortedMonths.map(month => (
                                <label key={month} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer', padding: '0.4rem 0.5rem', borderRadius: '4px', backgroundColor: selectedMonthsToDelete.has(month) ? '#fee2e2' : 'transparent' }}>
                                    <input
                                        type="checkbox"
                                        checked={selectedMonthsToDelete.has(month)}
                                        onChange={(e) => {
                                            const next = new Set(selectedMonthsToDelete);
                                            if (e.target.checked) next.add(month); else next.delete(month);
                                            setSelectedMonthsToDelete(next);
                                        }}
                                    />
                                    <span>{month}</span>
                                    {monthStatus[month] && (
                                        <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: '#6b7280' }}>
                                            {monthStatus[month].total} Rechnungen
                                        </span>
                                    )}
                                </label>
                            ))}
                        </div>
                        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                            <button className="btn" onClick={() => { setShowDeleteModal(false); setSelectedMonthsToDelete(new Set()); }}>Abbrechen</button>
                            <button
                                className="btn"
                                onClick={handleDeleteMonths}
                                disabled={selectedMonthsToDelete.size === 0 || deleting}
                                style={{ backgroundColor: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}
                            >
                                {deleting ? 'Löschen...' : `${selectedMonthsToDelete.size} Monat(e) löschen`}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {toast && <Toast {...toast} onClose={() => setToast(null)} />}
        </div>
    );
};

const getPaymentTypes = (inv: Invoice) => {
        if (inv.pmsPayments && inv.pmsPayments.length > 0) {
            return inv.pmsPayments.map(p => `${p.paymentType} (${Number(p.amount).toFixed(2)} €)`).join(' + ');
        }
        return inv.paymentType;
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
    const [commentValue, setCommentValue] = useState(inv.comment || '');
    const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Sync with props when they change (e.g. after refresh or initial load)
    useEffect(() => {
        setOptimisticManualStatus(inv.manualStatus);
        setOptimisticIsReconciled(inv.isReconciled);
    }, [inv.manualStatus, inv.isReconciled]);

    useEffect(() => {
        setCommentValue(inv.comment || '');
    }, [inv.comment]);

    const handleCommentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setCommentValue(val);
        if (debounceTimer.current) clearTimeout(debounceTimer.current);
        debounceTimer.current = setTimeout(() => {
            onCommentChange(inv.id, val);
        }, 500);
    };

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

    const hasMismatchSuggestion = !optimisticIsReconciled && !optimisticManualStatus && inv.matches && inv.matches.length > 0 && inv.matches.some(m => m.matchType === 'SUGGESTED_MISMATCH');

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
    } else if (hasMismatchSuggestion) {
        rowColor = '#fef08a'; // Yellow (Suggestion)
        textColor = '#854d0e'; // Dark yellow/brown text
    }

    return (
        <tr style={{ backgroundColor: rowColor, color: textColor }}>
            <td>{new Date(inv.invoiceDate).toLocaleDateString('de-DE')}</td>
            <td>
                {inv.invoiceNumber}
                {inv.roomReservations?.some(r => r.isAirbnb) && (
                    <span style={{ 
                        marginLeft: '8px', 
                        backgroundColor: '#ff385c', 
                        color: 'white', 
                        padding: '2px 6px', 
                        borderRadius: '4px', 
                        fontSize: '0.7rem', 
                        fontWeight: 'bold',
                        display: 'inline-block',
                        verticalAlign: 'middle'
                    }}>
                        Airbnb
                    </span>
                )}
            </td>
            <td>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span>{inv.recipient}</span>
                </div>
            </td>
            <td>{getPaymentTypes(inv)}</td>
            <td>
                <div style={{ fontWeight: 'bold' }}>{Number(inv.amount).toFixed(2)} €</div>
                {inv.cityTaxAmount ? (
                    <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '4px', lineHeight: '1.2' }}>
                        <div>CityTax: {Number(inv.cityTaxAmount).toFixed(2)} €</div>
                    </div>
                ) : null}
                {inv.status === 'PARTIAL' && (
                    <div style={{ fontSize: '0.75rem', color: '#b45309', marginTop: '2px' }}>
                        Teilzahlung ({Number(inv.amountPaid).toFixed(2)} €)
                    </div>
                )}
            </td>
            <td>
                <div className="tooltip-container">
                    <span className={`status-badge ${optimisticIsReconciled ? 'status-matched' : optimisticManualStatus ? 'status-manual' : inv.status === 'PARTIAL' ? 'status-partial' : hasMismatchSuggestion ? 'status-suggested' : 'status-open'}`}>
                        {optimisticIsReconciled ? (inv.matches && inv.matches.length > 0 ? 'Matched' : 'Manual') : inv.status === 'PARTIAL' ? 'Teilweise' : hasMismatchSuggestion ? 'Zahlungsart?' : 'Open'}
                    </span>
                    <div className="tooltip">
                        {getMatchDetails(inv)}
                    </div>
                </div>
            </td>
            <td>
                <input
                    type="checkbox"
                    checked={optimisticIsReconciled || optimisticManualStatus}
                    onChange={handleToggle}
                    style={{ width: '1.25rem', height: '1.25rem', cursor: 'pointer' }}
                />
            </td>
            <td>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <input
                        type="text"
                        value={commentValue}
                        onChange={handleCommentChange}
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


