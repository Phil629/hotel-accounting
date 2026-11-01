import 'dotenv/config';
import prisma from './db';

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
  matchedTransactions: {
    type: 'CARD' | 'BANK' | 'BOOKING';
    id: number;
    amount: number;
    date: string;
    details: string;
  }[];
  geminiUsed: boolean;
}

export async function investigateInvoiceWithAI(invoiceId: number, customApiKey?: string): Promise<AiMatchSuggestion> {
  const inv = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      matches: {
        include: {
          bankTransaction: true,
          cardPayment: true,
          bookingPayment: true,
        },
      },
      pmsPayments: true,
      roomReservations: true,
    },
  });

  if (!inv) {
    throw new Error(`Rechnung mit ID ${invoiceId} nicht gefunden.`);
  }

  const invDate = new Date(inv.invoiceDate);
  const invAmount = Number(inv.amount);
  const formattedDate = invDate.toLocaleDateString('de-DE');

  // Also query room reservations around this date/guest if not directly linked
  const relatedReservations = await prisma.roomReservation.findMany({
    where: {
      OR: [
        { invoiceId: inv.id },
        { checkOut: inv.invoiceDate },
      ],
    },
    take: 10,
  });

  // Candidate Bank transactions (-30 days to +45 days)
  const bStart = new Date(invDate);
  bStart.setDate(bStart.getDate() - 30);
  const bEnd = new Date(invDate);
  bEnd.setDate(bEnd.getDate() + 45);

  const bankTransactions = await prisma.bankTransaction.findMany({
    where: {
      bookingDate: { gte: bStart, lte: bEnd },
    },
    orderBy: { bookingDate: 'asc' },
    take: 100,
  });

  // Candidate Card & PayPal transactions (-3 days to +3 days)
  const cStart = new Date(invDate);
  cStart.setDate(cStart.getDate() - 3);
  const cEnd = new Date(invDate);
  cEnd.setDate(cEnd.getDate() + 3);

  const cardPayments = await prisma.cardPayment.findMany({
    where: {
      transactionDate: { gte: cStart, lte: cEnd },
    },
    orderBy: { transactionDate: 'asc' },
    take: 100,
  });

  // Candidate Booking transactions (-60 days to +30 days)
  const bpStart = new Date(invDate);
  bpStart.setDate(bpStart.getDate() - 60);
  const bpEnd = new Date(invDate);
  bpEnd.setDate(bpEnd.getDate() + 30);

  const bookingPayments = await prisma.bookingPayment.findMany({
    where: {
      payoutDate: { gte: bpStart, lte: bpEnd },
    },
    orderBy: { payoutDate: 'desc' },
    take: 40,
  });

  // Existing database matches
  const alreadyMatched = inv.matches.map(m => {
    if (m.cardPayment) return `ID #${m.cardPayment.id}: ${Number(m.cardPayment.amount).toFixed(2)} € per ${m.cardPayment.cardType} am ${new Date(m.cardPayment.transactionDate).toLocaleDateString('de-DE')}`;
    if (m.bankTransaction) return `ID #${m.bankTransaction.id}: ${Number(m.bankTransaction.amount).toFixed(2)} € per Banküberweisung am ${new Date(m.bankTransaction.bookingDate).toLocaleDateString('de-DE')} (Absender: ${m.bankTransaction.senderReceiver || 'Unbekannt'})`;
    if (m.bookingPayment) return `ID #${m.bookingPayment.id}: ${Number(m.bookingPayment.amount).toFixed(2)} € per Booking.com für Gast '${m.bookingPayment.guestName || 'Unbekannt'}' (Ref: ${m.bookingPayment.referenceNumber})`;
    return 'Unbekannt';
  });

  const prompt = `Du bist ein hochentwickelter, professioneller Buchhaltungs-Auditor für ein deutsches Hotel.
Deine Aufgabe ist es, diese Hotelrechnung völlig eigenständig und neutral anhand der vorliegenden Rohdaten zu prüfen – genau wie ein menschlicher Buchhalter.

--- RECHNUNGSDATEN ---
- Rechnungsnummer: ${inv.invoiceNumber}
- Rechnungsdatum: ${formattedDate}
- Rechnungsempfänger / Gast: ${inv.recipient}
- Rechnungs-Gesamtbetrag: ${invAmount.toFixed(2)} €
- Zahlart laut Hotelsoftware (PMS): ${inv.paymentType}
- Bisher im System zugeordnete Zahlungen: ${alreadyMatched.length > 0 ? alreadyMatched.join(', ') : 'Noch keine'}

--- AUFSCHLÜSSELUNG AUS DER HOTELSOFTWARE (PMS PAYMENTS) ---
${inv.pmsPayments.map(p => `- ${Number(p.amount).toFixed(2)} € gebucht als '${p.paymentType}' am ${new Date(p.paymentDate).toLocaleDateString('de-DE')}`).join('\n') || 'Keine PMS-Zahlungspositionen vorhanden'}

--- ZIMMERRESERVIERUNGEN AM ABREISETAG ---
${relatedReservations.map(r => `- Gast: '${r.guestName}', Zimmer ${r.roomName}, Logis: ${Number(r.price).toFixed(2)} €, CityTax: ${Number(r.cityTax || 0).toFixed(2)} €`).join('\n') || 'Keine Zimmerreservierungen gefunden'}

--- BANKÜBERWEISUNGEN IM ZEITRAUM (AUSZUG) ---
${bankTransactions.map(b => `- ID ${b.id}: ${Number(b.amount).toFixed(2)} € am ${new Date(b.bookingDate).toLocaleDateString('de-DE')} von '${b.senderReceiver || 'Unbekannt'}' | Verwendungszweck: '${b.description || ''}'`).join('\n') || 'Keine Banküberweisungen'}

--- KARTEN- & PAYPAL-ZAHLUNGEN (TERMINAL / ONLINE) IM ZEITRAUM ---
${cardPayments.map(c => `- ID ${c.id}: ${Number(c.amount).toFixed(2)} € (${c.cardType}) am ${new Date(c.transactionDate).toLocaleDateString('de-DE')}`).join('\n') || 'Keine Karten- oder PayPal-Zahlungen'}

--- BOOKING.COM AUSZAHLUNGEN IM ZEITRAUM ---
${bookingPayments.map(bp => `- ID ${bp.id}: ${Number(bp.amount).toFixed(2)} € für Gast '${bp.guestName || 'Unbekannt'}' (Auszahlung: ${bp.payoutDate ? new Date(bp.payoutDate).toLocaleDateString('de-DE') : 'k.A.'}, Ref: ${bp.referenceNumber})`).join('\n') || 'Keine Booking-Auszahlungen'}

--- DEINE PRÜFUNGSAUFGABE ---
1. Analysiere den Sachverhalt logisch über alle Zahlungswege (Banküberweisungen, Terminal-Kartenzahlungen, PayPal-Zahlungen, Booking-Auszahlungen):
   - Welcher Teil der Rechnung ist bereits gedeckt (z.B. Logis per PayPal oder Überweisung, CityTax vor Ort)?
   - Welcher Betrag steht noch offen und wie sollte dieser bezahlt werden (z.B. PayPal, Girocard, Überweisung)?
   - WICHTIG BEI PAYPAL: Wenn laut Hotelsoftware 'PayPal' gebucht ist oder der Gast online bezahlt hat, prüfe die Liste der Karten- & PayPal-Zahlungen sorgfältig. Häufig zahlen Gäste den reinen Zimmerpreis/Logis (z.B. 180.00 €) vorab per PayPal, während die CityTax (z.B. 6.00 €) offen bleibt. Ordne eine solche passende PayPal-Transaktion unbedingt zu und setze den Status auf PARTIAL (oder PAID, falls der Gesamtbetrag passt).
2. Strenge Vorsicht bei Zuordnungen:
   - Ordne eine Zahlung NUR zu, wenn Betrag und Kontext (Name, Gast, Rechnungsbetrag, Teilbetrag der Logis oder klares Zahlart-Schema) zusammenpassen.
   - Wenn eine Firmenrechnung per Überweisung bezahlt werden soll und auf dem Bankkonto kein passendes Geld eingegangen ist, ist die Rechnung "OPEN" (oder "PARTIAL", falls ein Teilbetrag bereits nachgewiesen ist). Erfinde NIEMALS fremde Zahlungen!
3. Wenn die Rechnung nicht vollständig bezahlt ist: Setze "status": "OPEN" oder "PARTIAL", nenne den genauen offenen Restbetrag und erkläre dem Nutzer verständlich auf Deutsch, was nachgewiesen wurde und was noch aussteht.

Antworte AUSSCHLIESSLICH im folgenden JSON-Format (kein Markdown-Codeblock, nur pures JSON):
{
  "status": "PAID" | "PARTIAL" | "OPEN",
  "headline": "Kurze, klare Überschrift",
  "explanation": "Detaillierte, professionelle Begründung (2-4 Sätze) auf Deutsch mit Nennung von Gast/Firma, Daten, Zahlart (z.B. PayPal) und noch offenem Restbetrag.",
  "confidence": 0.95,
  "suggestedComment": "Vorschlag für das Notizfeld",
  "matchedTransactions": [
    { "type": "BANK" | "CARD" | "BOOKING", "id": 12345, "amount": 180.00, "date": "07.10.2026", "details": "PayPal-Zahlung über ..." }
  ]
}`;

  const apiKey = customApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Kein Gemini API-Key konfiguriert. Bitte gib deinen API-Key im Modal ein oder hinterlege GEMINI_API_KEY in der Serverumgebung.');
  }

  // We call gemini-flash-lite-latest (fast, generous quota) with fallback to gemini-flash-latest
  const candidateModels = ['gemini-flash-lite-latest', 'gemini-flash-latest'];
  let lastError: string | null = null;

  for (const model of candidateModels) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
          },
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        console.error(`Gemini API error with model ${model}:`, res.status, errorText);
        lastError = `Gemini API Fehler (${res.status}): ${errorText.slice(0, 150)}`;
        continue;
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error('Gemini hat eine leere Antwort geliefert.');
      }

      const parsed = JSON.parse(text);
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        recipient: inv.recipient,
        amount: invAmount,
        date: formattedDate,
        status: parsed.status || 'OPEN',
        headline: parsed.headline || 'KI-Prüfung abgeschlossen',
        explanation: parsed.explanation || '',
        confidence: parsed.confidence || 0.9,
        suggestedComment: parsed.suggestedComment || '',
        matchedTransactions: parsed.matchedTransactions || [],
        geminiUsed: true,
      };
    } catch (e: any) {
      console.error(`Failed to call ${model}:`, e);
      lastError = e.message;
    }
  }

  // If Gemini failed on all models, throw error instead of faking results with heuristics!
  throw new Error(`Die KI-Prüfung konnte nicht durchgeführt werden: ${lastError || 'Keine Antwort von Gemini'}.`);
}

export async function applyAiMatch(invoiceId: number, data: {
  status?: 'PAID' | 'PARTIAL' | 'OPEN';
  amountPaid?: number;
  comment?: string;
  aiComment?: string;
  matches: {
    type: 'CARD' | 'BANK' | 'BOOKING';
    id: number;
  }[];
}) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw new Error(`Rechnung mit ID ${invoiceId} nicht gefunden`);

  const isReconciled = data.status === 'PAID';
  const targetAmountPaid = data.amountPaid !== undefined 
    ? data.amountPaid 
    : (data.status === 'PAID' ? Number(inv.amount) : inv.amountPaid);

  return await prisma.$transaction(async (tx) => {
    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        isReconciled: isReconciled,
        reconciledDate: isReconciled ? new Date() : null,
        manualStatus: isReconciled,
        status: data.status || 'PAID',
        amountPaid: targetAmountPaid,
        comment: data.comment !== undefined ? data.comment : inv.comment,
        aiComment: data.aiComment !== undefined ? data.aiComment : inv.aiComment,
      },
    });

    for (const m of data.matches || []) {
      const existing = await tx.reconciliationMatch.findFirst({
        where: {
          invoiceId,
          ...(m.type === 'CARD' ? { cardPaymentId: m.id } : {}),
          ...(m.type === 'BANK' ? { bankTransactionId: m.id } : {}),
          ...(m.type === 'BOOKING' ? { bookingPaymentId: m.id } : {}),
        },
      });

      if (!existing) {
        await tx.reconciliationMatch.create({
          data: {
            invoiceId,
            matchType: 'MANUAL',
            confidence: 1.0,
            cardPaymentId: m.type === 'CARD' ? m.id : undefined,
            bankTransactionId: m.type === 'BANK' ? m.id : undefined,
            bookingPaymentId: m.type === 'BOOKING' ? m.id : undefined,
          },
        });
      }
    }

    return updated;
  });
}
