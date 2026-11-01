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

function toCents(amount: any): number {
  return Math.round(Number(amount) * 100);
}

const STOP_WORDS = new Set([
  'das', 'der', 'die', 'und', 'von', 'zur', 'zum', 'gmbh', 'hotel', 'service', 
  'consulting', 'produktion', 'haftungsbeschraenkt', 'haus', 'berlin', 'agentur', 'ev', 'ag', 'co', 'kg'
]);

function getSignificantNameParts(name: string): string[] {
  return (name || '')
    .toLowerCase()
    .replace(/[,;.\-_/]/g, ' ')
    .split(/\s+/)
    .filter(p => p.length >= 3 && !STOP_WORDS.has(p));
}

function matchesNameWord(text: string, parts: string[]): boolean {
  if (!text || parts.length === 0) return false;
  const words = new Set(text.toLowerCase().replace(/[,;.\-_/]/g, ' ').split(/\s+/));
  return parts.some(p => words.has(p));
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

  // Extract hotel guest names from reservations if available
  let guestNames: string[] = [];
  if (inv.roomReservations && inv.roomReservations.length > 0) {
    guestNames = inv.roomReservations.map(r => r.guestName);
  }

  // ─── 1. Calculate already matched amounts and remaining balance ────────────
  let alreadyMatchedCents = 0;
  const existingMatchedItems: string[] = [];

  for (const m of inv.matches) {
    if (m.matchType === 'SUGGESTED_MISMATCH') continue;
    if (m.cardPayment) {
      alreadyMatchedCents += toCents(m.cardPayment.amount);
      existingMatchedItems.push(`${Number(m.cardPayment.amount).toFixed(2)} € per ${m.cardPayment.cardType} (Terminal #${m.cardPayment.id})`);
    } else if (m.bankTransaction) {
      alreadyMatchedCents += toCents(m.bankTransaction.amount);
      existingMatchedItems.push(`${Number(m.bankTransaction.amount).toFixed(2)} € per Banküberweisung (${new Date(m.bankTransaction.bookingDate).toLocaleDateString('de-DE')})`);
    } else if (m.bookingPayment) {
      alreadyMatchedCents += toCents(m.bookingPayment.amount);
      existingMatchedItems.push(`${Number(m.bookingPayment.amount).toFixed(2)} € per Booking.com (${m.bookingPayment.guestName})`);
    }
  }

  const remainingCents = Math.max(0, toCents(invAmount) - alreadyMatchedCents);
  const remainingAmount = remainingCents / 100;

  // If already 100% matched
  if (remainingCents <= 1) {
    return {
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      recipient: inv.recipient,
      amount: invAmount,
      date: formattedDate,
      status: 'PAID',
      headline: 'Bereits vollständig ausgeglichen',
      explanation: `Die Rechnung über ${invAmount.toFixed(2)} € ist bereits vollständig durch zugeordnete Zahlungen abgedeckt: ${existingMatchedItems.join(', ')}.`,
      confidence: 1.0,
      suggestedComment: 'Bereits vollständig ausgeglichen',
      matchedTransactions: [],
      geminiUsed: false,
    };
  }

  // Determine what payment method is expected for the UNMATCHED portion
  const pTypeLower = (inv.paymentType || '').toLowerCase();
  
  // Inspect PMS payments to see which sub-payments remain open
  let openPmsType = '';
  if (inv.pmsPayments && inv.pmsPayments.length > 0) {
    const unmatchedPms = inv.pmsPayments.filter(p => {
      const pCents = toCents(p.amount);
      const isMatched = inv.matches.some(m => {
        if (m.cardPayment && toCents(m.cardPayment.amount) === pCents) return true;
        if (m.bankTransaction && toCents(m.bankTransaction.amount) === pCents) return true;
        if (m.bookingPayment && toCents(m.bookingPayment.amount) === pCents) return true;
        return false;
      });
      return !isMatched;
    });
    if (unmatchedPms.length > 0) {
      openPmsType = unmatchedPms.map(p => `${p.paymentType} (${Number(p.amount).toFixed(2)} €)`).join(', ');
    }
  }

  const isBankExpected = openPmsType.toLowerCase().includes('bank') || openPmsType.toLowerCase().includes('überweisung') || pTypeLower.includes('bank') || pTypeLower.includes('überweisung') || pTypeLower.includes('rechnung');
  const isBookingExpected = openPmsType.toLowerCase().includes('booking') || pTypeLower.includes('booking');
  const isCardExpected = openPmsType.toLowerCase().includes('karte') || openPmsType.toLowerCase().includes('ec') || openPmsType.toLowerCase().includes('terminal') || pTypeLower.includes('karte') || pTypeLower.includes('ec');

  // Candidate Search
  const bStart = new Date(invDate);
  bStart.setDate(bStart.getDate() - 30);
  const bEnd = new Date(invDate);
  bEnd.setDate(bEnd.getDate() + 60);

  const candidateBanks = await prisma.bankTransaction.findMany({
    where: {
      bookingDate: { gte: bStart, lte: bEnd },
      OR: [
        { matches: { none: {} } },
        { matches: { some: { invoiceId: inv.id } } },
      ],
    },
    orderBy: { bookingDate: 'asc' },
  });

  const cStart = new Date(invDate);
  cStart.setDate(cStart.getDate() - 2);
  const cEnd = new Date(invDate);
  cEnd.setDate(cEnd.getDate() + 3);

  const candidateCards = await prisma.cardPayment.findMany({
    where: {
      transactionDate: { gte: cStart, lte: cEnd },
      OR: [
        { matches: { none: {} } },
        { matches: { some: { invoiceId: inv.id } } },
      ],
    },
    orderBy: { transactionDate: 'asc' },
  });

  const bpStart = new Date(invDate);
  bpStart.setDate(bpStart.getDate() - 90);
  const bpEnd = new Date(invDate);
  bpEnd.setDate(bpEnd.getDate() + 30);

  const allNames = [...getSignificantNameParts(inv.recipient), ...guestNames.flatMap(g => getSignificantNameParts(g))];

  const candidateBookings = await prisma.bookingPayment.findMany({
    where: {
      OR: [
        ...(allNames.length > 0 ? allNames.map(part => ({ guestName: { contains: part, mode: 'insensitive' as const } })) : []),
        {
          AND: [
            { amount: { in: [Number(inv.amount), remainingAmount] } },
            { payoutDate: { gte: bpStart, lte: bpEnd } },
          ],
        },
      ],
    },
    orderBy: { payoutDate: 'desc' },
  });

  // Rank candidate banks
  const scoredBanks = candidateBanks.map(b => {
    let score = 0;
    const bCents = toCents(b.amount);
    if (Math.abs(bCents - remainingCents) <= 1) score += 100;
    else if (Math.abs(bCents - toCents(invAmount)) <= 1) score += 80;
    if (allNames.some(p => `${b.senderReceiver || ''} ${b.description || ''}`.toLowerCase().includes(p))) score += 50;
    if ((b.description || '').includes(inv.invoiceNumber)) score += 150;
    const dayDiff = Math.abs((b.bookingDate.getTime() - invDate.getTime()) / 86400000);
    score -= dayDiff;
    return { b, score };
  }).sort((a, b) => b.score - a.score).map(x => x.b);

  // ─── 2. Optional Gemini Analysis ───────────────────────────────────────────
  const apiKey = customApiKey || process.env.GEMINI_API_KEY;

  if (apiKey && apiKey !== 'NO_KEY') {
    try {
      const prompt = `Du bist ein erfahrener Buchhaltungs-Auditor für ein deutsches Hotel.
Prüfe die folgende offene Hotel-Rechnung auf den Cent genau.

RECHNUNGSDATEN:
- Rechnungsnummer: ${inv.invoiceNumber}
- Datum: ${formattedDate}
- Empfänger / Firma: ${inv.recipient}
${guestNames.length > 0 ? `- Hotelgast: ${guestNames.join(', ')}` : ''}
- Gesamter Rechnungsbetrag: ${invAmount.toFixed(2)} €
- Bereits verbucht: ${(alreadyMatchedCents / 100).toFixed(2)} € (${existingMatchedItems.join(', ') || 'Keine'})
- NOCH OFFENER RESTBETRAG: ${remainingAmount.toFixed(2)} €
- Erwartete Zahlart für den Restbetrag laut PMS: ${openPmsType || inv.paymentType}

BANK-ÜBERWEISUNGEN IM ZEITFENSTER:
${scoredBanks.slice(0, 8).map(b => `- ID ${b.id}: ${Number(b.amount).toFixed(2)} € am ${new Date(b.bookingDate).toLocaleDateString('de-DE')} von '${b.senderReceiver || 'Unbekannt'}' | Zweck: '${b.description || ''}'`).join('\n') || 'Keine relevanten Überweisungen'}

${!isBankExpected ? `KARTENZAHLUNGEN (TERMINAL):
${candidateCards.slice(0, 10).map(c => `- ID ${c.id}: ${Number(c.amount).toFixed(2)} € (${c.cardType}) am ${new Date(c.transactionDate).toLocaleDateString('de-DE')}`).join('\n') || 'Keine ungematchten Kartenzahlungen'}` : 'Kartenzahlungen: Nicht relevant, da Zahlart Banküberweisung ist.'}

${isBookingExpected ? `BOOKING.COM AUSZAHLUNGEN:
${candidateBookings.slice(0, 5).map(bp => `- ID ${bp.id}: ${Number(bp.amount).toFixed(2)} € für Gast '${bp.guestName}' (Ref: ${bp.referenceNumber}, Auszahlung: ${bp.payoutDate ? new Date(bp.payoutDate).toLocaleDateString('de-DE') : 'k.A.'})`).join('\n') || 'Keine relevanten Booking-Auszahlungen'}` : ''}

WICHTIGE AUDIT-REGELN:
1. Wenn Zahlart Banküberweisung ist: Nur Überweisungen mit passendem Betrag (${remainingAmount.toFixed(2)} € oder ${invAmount.toFixed(2)} €) zuordnen. Wenn keine Überweisung existiert -> Status MUSS "OPEN" sein! NIEMALS Kartensplits für Banküberweisungen vorschlagen!
2. Wenn Zahlart Booking.com ist: Name des Gastes und Auszahlungsbetrag abgleichen.
3. Wenn Zahlart Karte ist: Nur Einzelzahlung oder echter 2-Karten-Split am selben Tag.
4. Sei präzise und nenne immer den genauen Status.

Antworte AUSSCHLIESSLICH als gültiges JSON im folgenden Format (ohne Markdown):
{
  "status": "PAID" | "PARTIAL" | "OPEN",
  "headline": "Prägnante Überschrift",
  "explanation": "Detaillierte, professionelle Begründung auf Deutsch.",
  "confidence": 0.95,
  "suggestedComment": "Kurzer Vorschlag für das Notizfeld",
  "matchedTransactions": [
    { "type": "BANK" | "CARD" | "BOOKING", "id": 12345, "amount": 154.00, "date": "22.09.2026", "details": "Überweisung von ..." }
  ]
}`;

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
          },
        }),
      });

      if (res.ok) {
        const json = await res.json();
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          const parsed = JSON.parse(text);
          return {
            invoiceId: inv.id,
            invoiceNumber: inv.invoiceNumber,
            recipient: inv.recipient,
            amount: invAmount,
            date: formattedDate,
            status: parsed.status || 'OPEN',
            headline: parsed.headline || 'Prüfung abgeschlossen',
            explanation: parsed.explanation || '',
            confidence: parsed.confidence || 0.9,
            suggestedComment: parsed.suggestedComment || '',
            matchedTransactions: parsed.matchedTransactions || [],
            geminiUsed: true,
          };
        }
      }
    } catch (geminiError) {
      console.log('Gemini call skipped/failed, falling back to deterministic auditor:', (geminiError as Error).message);
    }
  }

  // ─── 3. Deterministic Domain Auditor (Fallback) ───────────────────────────

  // A. Bank Transfer Expected
  if (isBankExpected) {
    const exactBank = candidateBanks.find(b => {
      const bCents = toCents(b.amount);
      const amountMatches = Math.abs(bCents - remainingCents) <= 1 || Math.abs(bCents - toCents(invAmount)) <= 1;
      const textMatches = allNames.some(p => `${b.senderReceiver || ''} ${b.description || ''}`.toLowerCase().includes(p)) || (b.description || '').includes(inv.invoiceNumber);
      return amountMatches && textMatches;
    }) || candidateBanks.find(b => {
      return Math.abs(toCents(b.amount) - remainingCents) <= 1 && (b.description || '').includes(inv.invoiceNumber);
    });

    if (exactBank) {
      const bDate = new Date(exactBank.bookingDate).toLocaleDateString('de-DE');
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        recipient: inv.recipient,
        amount: invAmount,
        date: formattedDate,
        status: 'PAID',
        headline: `Banküberweisung über ${Number(exactBank.amount).toFixed(2)} € gefunden`,
        explanation: `Am ${bDate} ging eine passende Überweisung von '${exactBank.senderReceiver || 'Unbekannt'}' über ${Number(exactBank.amount).toFixed(2)} € ein (Verwendungszweck: '${exactBank.description || ''}').`,
        confidence: 0.95,
        suggestedComment: `Banküberweisung von ${exactBank.senderReceiver || 'Kunde'} (${bDate})`,
        matchedTransactions: [{
          type: 'BANK',
          id: exactBank.id,
          amount: Number(exactBank.amount),
          date: bDate,
          details: `Absender: ${exactBank.senderReceiver} | Zweck: ${exactBank.description}`
        }],
        geminiUsed: false
      };
    }

    // Genuinely OPEN
    return {
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      recipient: inv.recipient,
      amount: invAmount,
      date: formattedDate,
      status: 'OPEN',
      headline: 'Kein Geldeingang auf dem Bankkonto gefunden (Offen)',
      explanation: existingMatchedItems.length > 0 
        ? `${existingMatchedItems.join(', ')} wurde bereits verbucht. Für den verbleibenden Rechnungsbetrag von ${remainingAmount.toFixed(2)} € (Zahlart: Banküberweisung) ist bisher keine Überweisung von '${inv.recipient}' eingegangen. Die Rechnung ist berechtigt offen.`
        : `Für die Rechnung über ${invAmount.toFixed(2)} € (Zahlart: Banküberweisung) konnte kein passender Geldeingang von '${inv.recipient}' auf den Hotel-Bankkonten festgestellt werden. Die Rechnung ist berechtigt offen.`,
      confidence: 0.95,
      suggestedComment: `Offene Forderung: Überweisung über ${remainingAmount.toFixed(2)} € steht noch aus`,
      matchedTransactions: [],
      geminiUsed: false
    };
  }

  // B. Booking.com Expected
  if (isBookingExpected) {
    const bookingMatch = candidateBookings.find(b => {
      const amountMatches = Math.abs(toCents(b.amount) - remainingCents) <= 1 || Math.abs(toCents(b.amount) - toCents(invAmount)) <= 1;
      const nameMatches = allNames.length > 0 && matchesNameWord(b.guestName || '', allNames);
      return amountMatches && nameMatches;
    }) || candidateBookings.find(b => Math.abs(toCents(b.amount) - remainingCents) <= 1);

    if (bookingMatch) {
      const pDate = bookingMatch.payoutDate ? new Date(bookingMatch.payoutDate).toLocaleDateString('de-DE') : 'k.A.';
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        recipient: inv.recipient,
        amount: invAmount,
        date: formattedDate,
        status: 'PAID',
        headline: `Booking.com Auszahlung (${Number(bookingMatch.amount).toFixed(2)} €) zugeordnet`,
        explanation: `Passende Booking.com-Auszahlung für Gast '${bookingMatch.guestName}' über ${Number(bookingMatch.amount).toFixed(2)} € gefunden (Auszahlungsdatum: ${pDate}, Ref: ${bookingMatch.referenceNumber}).`,
        confidence: 0.98,
        suggestedComment: `Booking.com Auszahlung #${bookingMatch.id} (${pDate})`,
        matchedTransactions: [{
          type: 'BOOKING',
          id: bookingMatch.id,
          amount: Number(bookingMatch.amount),
          date: pDate,
          details: `Booking.com Auszahlung für '${bookingMatch.guestName}' (Ref: ${bookingMatch.referenceNumber})`
        }],
        geminiUsed: false
      };
    }
  }

  // C. Card Expected
  if (isCardExpected) {
    // Single card
    const exactCard = candidateCards.find(c => Math.abs(toCents(c.amount) - remainingCents) <= 1);
    if (exactCard) {
      const cDate = new Date(exactCard.transactionDate).toLocaleDateString('de-DE');
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        recipient: inv.recipient,
        amount: invAmount,
        date: formattedDate,
        status: 'PAID',
        headline: `Kartenzahlung über ${Number(exactCard.amount).toFixed(2)} € gefunden`,
        explanation: `Am Nexi-Terminal wurde am ${cDate} eine passende Zahlung über ${Number(exactCard.amount).toFixed(2)} € (${exactCard.cardType}) erfasst.`,
        confidence: 0.95,
        suggestedComment: `Kartenzahlung ${Number(exactCard.amount).toFixed(2)} € (${exactCard.cardType})`,
        matchedTransactions: [{
          type: 'CARD',
          id: exactCard.id,
          amount: Number(exactCard.amount),
          date: cDate,
          details: `${exactCard.cardType} am Terminal (ID #${exactCard.id})`
        }],
        geminiUsed: false
      };
    }

    // Legitimate 2-card split on same day
    const cardsByDate: Record<string, typeof candidateCards> = {};
    for (const c of candidateCards) {
      const k = c.transactionDate.toISOString().split('T')[0];
      if (!cardsByDate[k]) cardsByDate[k] = [];
      cardsByDate[k].push(c);
    }
    for (const d of Object.keys(cardsByDate)) {
      const dayCards = cardsByDate[d];
      for (let i = 0; i < dayCards.length; i++) {
        for (let j = i + 1; j < dayCards.length; j++) {
          if (Math.abs(toCents(dayCards[i].amount) + toCents(dayCards[j].amount) - remainingCents) <= 1) {
            const splitDate = new Date(d).toLocaleDateString('de-DE');
            return {
              invoiceId: inv.id,
              invoiceNumber: inv.invoiceNumber,
              recipient: inv.recipient,
              amount: invAmount,
              date: formattedDate,
              status: 'PAID',
              headline: `Kartensplit (${Number(dayCards[i].amount).toFixed(2)} € + ${Number(dayCards[j].amount).toFixed(2)} €)`,
              explanation: `Am Nexi-Terminal wurden am ${splitDate} zwei Zahlungen erfasst, die zusammen exakt den offenen Betrag von ${remainingAmount.toFixed(2)} € ergeben: ${Number(dayCards[i].amount).toFixed(2)} € (${dayCards[i].cardType}) + ${Number(dayCards[j].amount).toFixed(2)} € (${dayCards[j].cardType}).`,
              confidence: 0.92,
              suggestedComment: `Terminal-Split: ${Number(dayCards[i].amount).toFixed(2)} € + ${Number(dayCards[j].amount).toFixed(2)} €`,
              matchedTransactions: [
                { type: 'CARD', id: dayCards[i].id, amount: Number(dayCards[i].amount), date: splitDate, details: `${dayCards[i].cardType} (ID #${dayCards[i].id})` },
                { type: 'CARD', id: dayCards[j].id, amount: Number(dayCards[j].amount), date: splitDate, details: `${dayCards[j].cardType} (ID #${dayCards[j].id})` }
              ],
              geminiUsed: false
            };
          }
        }
      }
    }
  }

  // D. Default -> OPEN
  return {
    invoiceId: inv.id,
    invoiceNumber: inv.invoiceNumber,
    recipient: inv.recipient,
    amount: invAmount,
    date: formattedDate,
    status: 'OPEN',
    headline: 'Keine passenden Zahlungseingänge gefunden (Rechnung offen)',
    explanation: `Weder auf den Bankkonten noch bei Kartenzahlungen konnte ein passender Zahlungseingang über ${remainingAmount.toFixed(2)} € für '${inv.recipient}' ermittelt werden. Die Forderung ist berechtigt offen.`,
    confidence: 0.90,
    suggestedComment: 'Rechnung noch offen - kein Zahlungseingang gefunden',
    matchedTransactions: [],
    geminiUsed: false
  };
}

export async function applyAiMatch(invoiceId: number, data: {
  status?: 'PAID' | 'PARTIAL' | 'OPEN';
  amountPaid?: number;
  comment?: string;
  matches: {
    type: 'CARD' | 'BANK' | 'BOOKING';
    id: number;
  }[];
}) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw new Error(`Rechnung mit ID ${invoiceId} nicht gefunden`);

  const isReconciled = data.status !== 'OPEN';
  const targetAmountPaid = data.amountPaid !== undefined ? data.amountPaid : Number(inv.amount);

  return await prisma.$transaction(async (tx) => {
    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        isReconciled: isReconciled,
        reconciledDate: isReconciled ? new Date() : null,
        manualStatus: isReconciled,
        status: data.status || 'PAID',
        amountPaid: isReconciled ? targetAmountPaid : inv.amountPaid,
        comment: data.comment !== undefined ? data.comment : inv.comment,
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
