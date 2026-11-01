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

  // Candidate target amounts
  const targetAmounts = [invAmount, ...inv.pmsPayments.map(p => Number(p.amount))].filter(a => a > 0);

  // Extract recipient keywords for search (min length 4, no generic words)
  const recipientKeywords = (inv.recipient || '')
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !['gmbh', 'hotel', 'herr', 'frau', 'prof', 'dr', 'und', 'der', 'die', 'das', 'fuer', 'für'].includes(w));

  // Candidate Bank transactions (-30 days to +45 days)
  const bStart = new Date(invDate);
  bStart.setDate(bStart.getDate() - 30);
  const bEnd = new Date(invDate);
  bEnd.setDate(bEnd.getDate() + 45);

  const rawBankTransactions = await prisma.bankTransaction.findMany({
    where: {
      bookingDate: { gte: bStart, lte: bEnd },
      // Exclude transactions already matched to OTHER invoices
      matches: { none: { invoiceId: { not: inv.id } } },
    },
    orderBy: { bookingDate: 'asc' },
    take: 100,
  });

  // Pre-filter bank transactions: must either match target amount or contain keyword/invoiceNumber
  const bankTransactions = rawBankTransactions.filter(b => {
    const amt = Number(b.amount);
    const amtMatch = targetAmounts.some(ta => Math.abs(amt - ta) < 0.05);
    if (amtMatch) return true;
    const text = `${b.senderReceiver || ''} ${b.description || ''}`.toLowerCase();
    if (text.includes(inv.invoiceNumber.toLowerCase())) return true;
    return recipientKeywords.some(kw => text.includes(kw));
  });

  // Candidate Card & PayPal transactions (-3 days to +3 days)
  const cStart = new Date(invDate);
  cStart.setDate(cStart.getDate() - 3);
  const cEnd = new Date(invDate);
  cEnd.setDate(cEnd.getDate() + 3);

  const rawCardPayments = await prisma.cardPayment.findMany({
    where: {
      transactionDate: { gte: cStart, lte: cEnd },
      // Exclude card payments already matched to OTHER invoices
      matches: { none: { invoiceId: { not: inv.id } } },
    },
    orderBy: { transactionDate: 'asc' },
    take: 100,
  });

  // Pre-filter card/PayPal payments: MUST match invoice amount or a PMS component amount!
  // (Card transactions have no recipient text, so matching by exact amount is essential)
  const cardPayments = rawCardPayments.filter(c => {
    const amt = Number(c.amount);
    return targetAmounts.some(ta => Math.abs(amt - ta) < 0.05);
  });

  // Candidate Booking transactions (-60 days to +30 days)
  const bpStart = new Date(invDate);
  bpStart.setDate(bpStart.getDate() - 60);
  const bpEnd = new Date(invDate);
  bpEnd.setDate(bpEnd.getDate() + 30);

  const rawBookingPayments = await prisma.bookingPayment.findMany({
    where: {
      payoutDate: { gte: bpStart, lte: bpEnd },
      matches: { none: { invoiceId: { not: inv.id } } },
    },
    orderBy: { payoutDate: 'desc' },
    take: 40,
  });

  const bookingPayments = rawBookingPayments.filter(bp => {
    const amt = Number(bp.amount);
    if (targetAmounts.some(ta => Math.abs(amt - ta) < 0.05)) return true;
    const gName = (bp.guestName || '').toLowerCase();
    return recipientKeywords.some(kw => gName.includes(kw));
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
   - Welcher Betrag steht noch offen und wie sollte dieser bezahlt werden?
2. STRENGSTE REGEL FÜR ZAHLUNGSZUORDNUNGEN (matchedTransactions):
   - Der Betrag einer Transaktion MUSS AUF DEN CENT GENAU mit dem Rechnungs-Gesamtbetrag ODER einem der im PMS ausgewiesenen Teilbeträge (z. B. Logis oder CityTax) übereinstimmen!
   - Es ist STRENGSTENS VERBOTEN, eine Transaktion mit abweichendem Betrag zuzuordnen (Beispiel: Für eine Rechnung über 84.00 € mit 81.00 € PayPal darf NIEMALS eine Transaktion über 124.00 € zugeordnet werden!).
   - Wenn in den vorliegenden Auszügen kein passender Betrag existiert, darfst du KEINE Transaktion zuordnen (matchedTransactions: [])!
3. STATUS-KONSISTENZ:
   - "PAID": Nur wenn der gesamte Rechnungsbetrag durch passende Zahlungen zu 100% nachgewiesen ist.
   - "PARTIAL": Nur wenn ein echter Teilbetrag nachgewiesen ist UND noch ein echter Restbetrag > 0.00 € offen ist.
   - "OPEN": Wenn kein Geldeingang nachgewiesen werden konnte.
   - Setze NIEMALS "status": "PARTIAL", wenn kein Restbetrag mehr offen ist!

Antworte AUSSCHLIESSLICH im folgenden JSON-Format (kein Markdown-Codeblock, nur pures JSON):
{
  "status": "PAID" | "PARTIAL" | "OPEN",
  "headline": "Kurze, klare Überschrift",
  "explanation": "Detaillierte, professionelle Begründung (2-4 Sätze) auf Deutsch mit Nennung von Gast/Firma, Daten, Zahlart und noch offenem Restbetrag.",
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

  // We prefer gemini-3.5-flash (high intelligence & reasoning) with fallback to gemini-flash-lite-latest
  const candidateModels = ['gemini-3.5-flash', 'gemini-flash-lite-latest'];
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

      // --- SERVER-SIDE VALIDATION & GUARD RAILS ---
      let validatedMatches: any[] = [];
      if (Array.isArray(parsed.matchedTransactions)) {
        validatedMatches = parsed.matchedTransactions.filter((tx: any) => {
          const txAmount = Number(tx.amount || 0);
          // An individual match cannot exceed the invoice amount
          if (txAmount > invAmount + 0.05) {
            console.warn(`[AI Validation] Rejecting match ${tx.id}: amount ${txAmount} exceeds invoice amount ${invAmount}`);
            return false;
          }
          // Must exist in candidate list with matching amount
          if (tx.type === 'CARD') {
            const exists = cardPayments.some(c => c.id === Number(tx.id) && Math.abs(Number(c.amount) - txAmount) < 0.05);
            if (!exists) console.warn(`[AI Validation] Rejecting CARD match ${tx.id}: not found in candidates or amount mismatch`);
            return exists;
          }
          if (tx.type === 'BANK') {
            const exists = bankTransactions.some(b => b.id === Number(tx.id) && Math.abs(Number(b.amount) - txAmount) < 0.05);
            if (!exists) console.warn(`[AI Validation] Rejecting BANK match ${tx.id}: not found in candidates or amount mismatch`);
            return exists;
          }
          if (tx.type === 'BOOKING') {
            const exists = bookingPayments.some(bp => bp.id === Number(tx.id) && Math.abs(Number(bp.amount) - txAmount) < 0.05);
            if (!exists) console.warn(`[AI Validation] Rejecting BOOKING match ${tx.id}: not found in candidates or amount mismatch`);
            return exists;
          }
          return false;
        });
      }

      // Total of validated matches cannot exceed invoice amount
      let validMatchedSum = validatedMatches.reduce((s, t) => s + Number(t.amount || 0), 0);
      if (validMatchedSum > invAmount + 0.05) {
        validatedMatches = [];
        validMatchedSum = 0;
      }

      // Enforce status consistency
      let finalStatus: 'PAID' | 'PARTIAL' | 'OPEN' = parsed.status || 'OPEN';
      if (validMatchedSum === 0) {
        finalStatus = 'OPEN';
      } else if (Math.abs(validMatchedSum - invAmount) < 0.05) {
        finalStatus = 'PAID';
      } else if (validMatchedSum < invAmount) {
        finalStatus = 'PARTIAL';
      }

      let finalHeadline = parsed.headline || 'KI-Prüfung abgeschlossen';
      let finalExplanation = parsed.explanation || '';
      let finalComment = parsed.suggestedComment || '';

      // If status is OPEN, sanitize any hallucinated "paid" text
      if (finalStatus === 'OPEN') {
        const headlineLower = finalHeadline.toLowerCase();
        if (headlineLower.includes('bezahlt') || headlineLower.includes('beglichen') || headlineLower.includes('ausgeglichen')) {
          finalHeadline = 'Rechnung vollständig offen';
        }
        const explLower = finalExplanation.toLowerCase();
        if (explLower.includes('beglichen') || explLower.includes('vollständig bezahlt') || (validatedMatches.length === 0 && (parsed.matchedTransactions?.length || 0) > 0)) {
          finalExplanation = `Laut Hotelsoftware wurde die Zahlung als '${inv.paymentType}' erwartet. In den vorliegenden Bank-, Karten- und Booking-Daten konnte jedoch kein entsprechender Geldeingang über ${invAmount.toFixed(2)} € nachgewiesen werden. Der Rechnungsbetrag ist daher weiterhin vollständig offen.`;
          finalComment = `Offen: Kein Geldeingang über ${invAmount.toFixed(2)} € (${inv.paymentType}) nachgewiesen.`;
        }
      } else if (finalStatus === 'PARTIAL') {
        const remaining = Math.max(0, Math.round((invAmount - validMatchedSum) * 100) / 100);
        const headlineLower = finalHeadline.toLowerCase();
        if (headlineLower.includes('vollständig') || headlineLower.includes('beglichen') || headlineLower.includes('ausgeglichen')) {
          finalHeadline = `Teilzahlung nachgewiesen – ${remaining.toFixed(2)} € Restbetrag offen`;
        }
        const explLower = finalExplanation.toLowerCase();
        if (explLower.includes('vollständig ausgeglichen') || explLower.includes('vollständig bezahlt') || explLower.includes('kein offener betrag') || explLower.includes('0.00 € noch offen') || explLower.includes('restbetrag von 0.00 €')) {
          finalExplanation = `Für diese Rechnung wurden ${validMatchedSum.toFixed(2)} € nachgewiesen. Der verbleibende Restbetrag von ${remaining.toFixed(2)} € steht jedoch noch aus und konnte in den Auszügen nicht nachgewiesen werden.`;
          finalComment = `Teilzahlung über ${validMatchedSum.toFixed(2)} € zugeordnet. Restbetrag von ${remaining.toFixed(2)} € noch offen.`;
        }
      }

      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        recipient: inv.recipient,
        amount: invAmount,
        date: formattedDate,
        status: finalStatus,
        headline: finalHeadline,
        explanation: finalExplanation,
        confidence: parsed.confidence || 0.9,
        suggestedComment: finalComment,
        matchedTransactions: validatedMatches,
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
