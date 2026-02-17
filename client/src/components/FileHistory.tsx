import React, { useEffect, useState } from 'react';
import { api } from '../api';

interface ImportedFile {
    id: number;
    filename: string;
    originalName: string;
    type: string;
    importDate: string;
    recordCount: number;
    dateRangeStart: string | null;
    dateRangeEnd: string | null;
    logs?: string;
}

export const FileHistory: React.FC = () => {
    const [files, setFiles] = useState<ImportedFile[]>([]);
    const [visibleCount, setVisibleCount] = useState(5);

    useEffect(() => {
        api.getFiles().then(setFiles).catch(console.error);
    }, []);

    const showLogs = (logs?: string) => {
        if (!logs) return alert("No logs available.");
        try {
            const parsed = JSON.parse(logs);
            alert(parsed.join('\n'));
        } catch {
            alert(logs);
        }
    };

    const loadMore = () => {
        setVisibleCount(prev => prev + 5);
    };

    const visibleFiles = files.slice(0, visibleCount);

    return (
        <div className="card" style={{ marginTop: '2rem' }}>
            <h3>Upload History</h3>
            <div className="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Filename</th>
                            <th>Type</th>
                            <th>Records</th>
                            <th>Date Range</th>
                            <th>Imported At</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {visibleFiles.map(file => (
                            <tr key={file.id} style={{ backgroundColor: file.type === 'DUPLICATE' ? '#fef2f2' : 'transparent' }}>
                                <td>
                                    <div>{file.filename}</div>
                                    <small style={{ color: 'var(--text-secondary)' }}>{file.originalName}</small>
                                </td>
                                <td>
                                    <span className="status-badge" style={{
                                        background: file.type === 'DUPLICATE' ? '#fee2e2' : file.type === 'ERROR' ? '#fef2f2' : '#e0f2fe',
                                        color: file.type === 'DUPLICATE' ? '#991b1b' : file.type === 'ERROR' ? '#991b1b' : '#0369a1'
                                    }}>
                                        {file.type}
                                    </span>
                                </td>
                                <td>{file.recordCount}</td>
                                <td>
                                    {file.dateRangeStart ? new Date(file.dateRangeStart).toLocaleDateString() : '-'}
                                    {' - '}
                                    {file.dateRangeEnd ? new Date(file.dateRangeEnd).toLocaleDateString() : '-'}
                                </td>
                                <td>{new Date(file.importDate).toLocaleString()}</td>
                                <td>
                                    <button className="btn" onClick={() => showLogs(file.logs)} style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}>
                                        View Logs
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {visibleCount < files.length && (
                <div style={{ textAlign: 'center', marginTop: '1rem' }}>
                    <button className="btn" onClick={loadMore}>
                        Load More ({files.length - visibleCount} remaining)
                    </button>
                </div>
            )}
        </div>
    );
};
