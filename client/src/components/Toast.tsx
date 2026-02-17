import React, { useEffect } from 'react';

export interface ToastProps {
    message: string;
    type: 'success' | 'error' | 'info';
    onClose: () => void;
    duration?: number;
}

export const Toast: React.FC<ToastProps> = ({ message, type, onClose, duration = 3000 }) => {
    useEffect(() => {
        const timer = setTimeout(() => {
            onClose();
        }, duration);
        return () => clearTimeout(timer);
    }, [duration, onClose]);

    const colors = {
        success: { bg: '#10b981', border: '#059669' },
        error: { bg: '#ef4444', border: '#dc2626' },
        info: { bg: '#3b82f6', border: '#2563eb' }
    };

    const color = colors[type];

    return (
        <div
            style={{
                position: 'fixed',
                top: '20px',
                right: '20px',
                backgroundColor: color.bg,
                color: 'white',
                padding: '1rem 1.5rem',
                borderRadius: '8px',
                boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
                border: `2px solid ${color.border}`,
                zIndex: 9999,
                minWidth: '300px',
                maxWidth: '500px',
                animation: 'slideIn 0.3s ease-out',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '1rem'
            }}
        >
            <span style={{ flex: 1 }}>{message}</span>
            <button
                onClick={onClose}
                style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'white',
                    fontSize: '1.5rem',
                    cursor: 'pointer',
                    padding: '0',
                    lineHeight: '1'
                }}
            >
                ×
            </button>
            <style>{`
                @keyframes slideIn {
                    from {
                        transform: translateX(400px);
                        opacity: 0;
                    }
                    to {
                        transform: translateX(0);
                        opacity: 1;
                    }
                }
            `}</style>
        </div>
    );
};
