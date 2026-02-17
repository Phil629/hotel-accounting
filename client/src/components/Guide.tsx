import React, { useState } from 'react';

export const Guide: React.FC = () => {
    const [activeTab, setActiveTab] = useState<'booking' | 'nexi' | 'ibelsa'>('booking');

    const tabs = [
        { id: 'booking', label: 'Booking.com', icon: '📊', color: 'blue' },
        { id: 'nexi', label: 'Nexi', icon: '💳', color: 'purple' },
        { id: 'ibelsa', label: 'Ibelsa', icon: '🏨', color: 'green' }
    ] as const;

    return (
        <div className="p-8 max-w-5xl mx-auto">
            <div className="mb-10 text-center">
                <h1 className="text-3xl font-bold text-gray-900 mb-2">Datenexport Anleitung</h1>
                <p className="text-gray-500">Schritt-für-Schritt Anleitungen für den Datenabgleich</p>
            </div>

            {/* Modern Tab Navigation (Pill Style) */}
            <div className="flex justify-center mb-10">
                <div className="bg-gray-100 p-1.5 rounded-xl inline-flex shadow-inner">
                    {tabs.map((tab) => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={`
                                px-6 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200 flex items-center gap-2
                                ${activeTab === tab.id
                                    ? 'bg-white text-gray-900 shadow-sm ring-1 ring-black/5 scale-100'
                                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200/50'
                                }
                            `}
                        >
                            <span className="text-lg">{tab.icon}</span>
                            {tab.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
                {/* Booking.com Content */}
                {activeTab === 'booking' && (
                    <div className="divide-y divide-gray-100">
                        <Step
                            number={1}
                            title="Zu den Auszahlungen navigieren"
                            description={
                                <span>
                                    Loggen Sie sich im Booking.com Extranet ein. Klicken Sie im oberen Menü auf <strong className="text-blue-600">Finanzen</strong> und wählen Sie im Dropdown-Menü den Punkt <strong className="text-blue-600">Informationen zu Auszahlungen</strong>.
                                </span>
                            }
                            imageSrc="/guide/step1_new.png"
                        />
                        <Step
                            number={2}
                            title="Zeitraum auswählen"
                            description='Wählen Sie im Bereich "Auszahlungszeitraum" bei "Von" und "Bis" den gewünschten Monat aus (z.B. 1. Nov bis 30. Nov).'
                            imageSrc="/guide/step2_new.png"
                        />
                        <Step
                            number={3}
                            title="Übersichten herunterladen"
                            description={
                                <span>
                                    Klicken Sie auf den Button <strong className="text-blue-600">Alle Übersichten herunterladen</strong> (rechts oben).
                                    <br />
                                    <span className="inline-block mt-2 text-sm text-gray-500 bg-gray-50 px-2 py-1 rounded border border-gray-200">
                                        💡 Wichtig: Laden Sie diese Datei anschließend im Dashboard hoch.
                                    </span>
                                </span>
                            }
                            imageSrc="/guide/step3_new.png"
                        />
                    </div>
                )}

                {/* Nexi Content */}
                {activeTab === 'nexi' && (
                    <div className="divide-y divide-gray-100">
                        <Step
                            number={1}
                            title="Zur Transaktionssuche navigieren"
                            description={
                                <span>
                                    Loggen Sie sich im Nexi-Portal ein. Klicken Sie im oberen Menü auf <strong className="text-purple-600">Research</strong> und wählen Sie dann <strong className="text-purple-600">Transaktionssuche</strong>.
                                </span>
                            }
                            imageSrc="/guide/nexi_step1_new.png"
                        />
                        <Step
                            number={2}
                            title="Monat auswählen und suchen"
                            description='Wählen Sie im Feld "Transaktionsdatum von" und "Transaktionsdatum bis" den gewünschten Monat aus. Klicken Sie dann auf SUCHEN.'
                            imageSrc="/guide/nexi_step2_new.png"
                        />
                        <Step
                            number={3}
                            title="Als CSV exportieren"
                            description={
                                <span>
                                    Klicken Sie rechts oben auf <strong className="text-purple-600">EXPORT</strong> und wählen Sie <strong>CSV</strong> aus.
                                    <br />
                                    <span className="inline-block mt-2 text-sm text-gray-500 bg-gray-50 px-2 py-1 rounded border border-gray-200">
                                        💡 Wichtig: Laden Sie diese Datei anschließend im Dashboard hoch.
                                    </span>
                                </span>
                            }
                            imageSrc="/guide/nexi_step3_new.png"
                        />
                    </div>
                )}

                {/* Ibelsa Content */}
                {activeTab === 'ibelsa' && (
                    <div className="divide-y divide-gray-100">
                        <Step
                            number={1}
                            title="Zahlungsbericht exportieren"
                            description={
                                <div>
                                    <p className="mb-2">Navigieren Sie zu <strong className="text-green-600">Berichte</strong> → <strong className="text-green-600">Zahlungsbericht</strong>.</p>
                                    <ul className="list-disc list-inside text-gray-600 space-y-1 ml-1">
                                        <li>Zeitraum: Gewünschten Monat wählen</li>
                                        <li>Format: "CSV (Excel) Export" aktivieren</li>
                                    </ul>
                                    <span className="inline-block mt-3 text-sm text-gray-500 bg-gray-50 px-2 py-1 rounded border border-gray-200">
                                        💡 Wichtig: Laden Sie diese Datei anschließend im Dashboard hoch.
                                    </span>
                                </div>
                            }
                            imageSrc="/guide/ibelsa_step1_new.png"
                        />
                    </div>
                )}
            </div>
        </div>
    );
};

// Reusable Step Component for consistency
const Step: React.FC<{ number: number; title: string; description: React.ReactNode; imageSrc: string }> = ({ number, title, description, imageSrc }) => (
    <div className="p-8 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left: Text Content */}
        <div className="lg:col-span-4 space-y-4">
            <div className="flex items-center gap-4">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-lg shadow-sm">
                    {number}
                </div>
                <h3 className="text-xl font-bold text-gray-900">{title}</h3>
            </div>
            <div className="text-gray-600 leading-relaxed pl-14">
                {description}
            </div>
        </div>

        {/* Right: Image Container */}
        <div className="lg:col-span-8">
            <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 flex items-center justify-center h-[400px]">
                <img
                    src={imageSrc}
                    alt={title}
                    className="max-w-full max-h-full object-contain shadow-sm rounded-lg"
                    style={{ imageRendering: 'crisp-edges' }} // Helps with text in screenshots
                />
            </div>
        </div>
    </div>
);
