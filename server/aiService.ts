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
  return name
    .toLowerCase()
    .replace(/[,;.\-_/]/g, ' ')
    .split(/\s+/)
    .filter(p => p.length >= 3 && !STOP_WORDS.has(p));
}

function matchesNameWord(text: string, parts: string[]): boolean {
  if (!text || parts.length === 0) return false;
  const words = new Set(text.toLowerCase().replace(/[,;.\-_/]/g, ' ').split(/\s+/));
  // Exact word match
  return parts.some(p => words.has(p));
}

// Find subset of items whose amounts sum to targetCents
function findSubsetSum<T extends { amount: any }>(items: T[], targetCents: number, maxItems = 4): T[] | null {
  const sorted = [...items].sort((a, b) => Number(b.amount) - Number(a.amount));

  function backtrack(index: number, currentSum: number, chosen: T[]): T[] | null {
    if (Math.abs(currentSum - targetCents) <= 1) {
      return chosen;
    }
    if (chosen.length >= maxItems || currentSum > targetCents + 1 || index >= sorted.length) {
      return null;
    }

    for (let i = index; i < sorted.length; i++) {
      const itemCents = toCents(sorted[i].amount);
      const res = backtrack(i + 1, currentSum + itemCents, [...chosen, sorted[i]]);
      if (res) return res;
    }
    return null;
  }

  return backtrack(0, 0, []);
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
  const targetCents = toCents(invAmount);
  const formattedDate = invDate.toLocaleDateString('de-DE');
  const pTypeLower = (inv.paymentType || '').toLowerCase();
  const nameParts = getSignificantNameParts(inv.recipient);

  // ─── 1. Candidate Search ───────────────────────────────────────────────────

  // A. Card Payments (Nexi) on or near invoice date (-2 days to +3 days)
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

  // B. Bank Transactions (-30 days to +60 days)
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

  // C. Booking.com Payments (-90 days to +30 days)
  const bpStart = new Date(invDate);
  bpStart.setDate(bpStart.getDate() - 90);
  const bpEnd = new Date(invDate);
  bpEnd.setDate(bpEnd.getDate() + 30);

  const candidateBookings = await prisma.bookingPayment.findMany({
    where: {
      OR: [
        ...(nameParts.length > 0 ? nameParts.map(part => ({ guestName: { contains: part, mode: 'insensitive' as const } })) : []),
        {
          AND: [
            { amount: inv.amount },
            { payoutDate: { gte: bpStart, lte: bpEnd } },
          ],
        },
      ],
    },
    orderBy: { payoutDate: 'desc' },
  });

  // ─── 2. Gemini LLM Analysis (if API key available) ─────────────────────────
  const apiKey = customApiKey || process.env.GEMINI_API_KEY;

  if (apiKey) {
    try {
      const prompt = `Du bist ein erfahrener Buchhaltungs-Auditor für ein Hotel in Deutschland.
Prüfe die folgende offene Hotel-Rechnung und die potenziell passenden Zahlungseingänge aus der Datenbank.

RECHNUNGSDATEN:
- Nummer: ${inv.invoiceNumber}
- Datum: ${formattedDate}
- Gast / Firma: ${inv.recipient}
- Rechnungsbetrag: ${invAmount.toFixed(2)} €
- Zahlart laut Hotelsoftware: ${inv.paymentType}
- Bisher als bezahlt markiert: ${Number(inv.amountPaid).toFixed(2)} €
- Bestehender Kommentar: ${inv.comment || 'Keiner'}

POTENZIELL PASSENDE BANK-ÜBERWEISUNGEN:
${candidateBanks.slice(0, 10).map(b => `- ID ${b.id}: ${Number(b.amount).toFixed(2)} € am ${new Date(b.bookingDate).toLocaleDateString('de-DE')} von '${b.senderReceiver || 'Unbekannt'}' | Verwendungszweck: '${b.description || ''}'`).join('\n') || 'Keine Banküberweisungen im Zeitfenster'}

POTENZIELL PASSENDE KARTENZAHLUNGEN (NEXI TERMINAL):
${candidateCards.slice(0, 12).map(c => `- ID ${c.id}: ${Number(c.amount).toFixed(2)} € (${c.cardType}) am ${new Date(c.transactionDate).toLocaleDateString('de-DE')}`).join('\n') || 'Keine ungematchten Kartenzahlungen'}

POTENZIELL PASSENDE BOOKING.COM AUSZAHLUNGEN:
${candidateBookings.slice(0, 6).map(bp => `- ID ${bp.id}: ${Number(bp.amount).toFixed(2)} € für Gast '${bp.guestName || 'Unbekannt'}' (Ref: ${bp.referenceNumber}, Auszahlung: ${bp.payoutDate ? new Date(bp.payoutDate).toLocaleDateString('de-DE') : 'k.A.'})`).join('\n') || 'Keine Booking-Auszahlungen'}

AUFGABE:
1. Prüfe, ob eine oder mehrere dieser Transaktionen zu der Rechnung gehören.
2. Achte besonders auf:
   - Inhaber / Geschäftsführer bei Firmenrechnungen (z.B. Katja Schoßmann = Inhaberin DAS KOMMUNIKATIONSHAUS)
   - Kartensplits am Terminal (mehrere Buchungen am selben Tag, die zusammen exakt die Rechnungssumme ergeben)
   - Bei Zahlart Booking.com: Name des Gastes und Auszahlungsbetrag
3. Wenn keine passende Transaktion existiert, ist die Rechnung 'OPEN' (wirklich unbezahlt).

Antworte AUSSCHLIESSLICH als gültiges JSON im folgenden Schema (kein Codeblock):
{
  "status": "PAID" | "PARTIAL" | "OPEN",
  "headline": "Kurzer prägnanter Titel",
  "explanation": "Detaillierte, klare Begründung in 2-3 Sätzen auf Deutsch mit Nennung von Datum, Betrag und Absender/Terminal.",
  "confidence": 0.95,
  "suggestedComment": "Notiz für das Kommentarfeld",
  "matchedTransactions": [
    { "type": "BANK" | "CARD" | "BOOKING", "id": 12345, "amount": 154.00, "date": "22.09.2026", "details": "Überweisung von ..." }
  ]
}`;

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      console.error('Error in Gemini analysis:', geminiError);
    }
  }

  // ─── 3. Heuristic Priority Evaluation (Deterministic) ──────────────────────

  const isBankPreferred = pTypeLower.includes('bank') || pTypeLower.includes('überweisung') || pTypeLower.includes('rechnung');
  const isBookingPreferred = pTypeLower.includes('booking');

  // Check Exact Bank Match
  const exactBankMatches = candidateBanks.filter(b => Math.abs(toCents(b.amount) - targetCents) <= 1);

  // Check Card Splits
  const cardsByDate: Record<string, typeof candidateCards> = {};
  for (const c of candidateCards) {
    const k = c.transactionDate.toISOString().split('T')[0];
    if (!cardsByDate[k]) cardsByDate[k] = [];
    cardsByDate[k].push(c);
  }

  let matchedCards: typeof candidateCards | null = null;
  let matchedCardDate = '';

  for (const d of Object.keys(cardsByDate)) {
    const subset = findSubsetSum(cardsByDate[d], targetCents, 4);
    if (subset) {
      matchedCards = subset;
      matchedCardDate = d;
      break;
    }
  }

  // Check Booking Match
  // Prioritize exact amount match + exact name word match
  const exactBookingGuest = candidateBookings.find(b => {
    if (!b.guestName) return false;
    const amountMatches = Math.abs(toCents(b.amount) - targetCents) <= 1;
    const nameMatches = matchesNameWord(b.guestName, nameParts);
    return amountMatches && nameMatches;
  }) || (isBookingPreferred ? candidateBookings.find(b => {
    if (!b.guestName) return false;
    const amountMatches = Math.abs(toCents(b.amount) - targetCents) <= 1;
    return amountMatches;
  }) : null);

  // Decision 1: If Booking match found and either paymentType is Booking or both amount & name matched
  if (exactBookingGuest) {
    const payoutStr = exactBookingGuest.payoutDate ? new Date(exactBookingGuest.payoutDate).toLocaleDateString('de-DE') : 'k.A.';
    return {
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      recipient: inv.recipient,
      amount: invAmount,
      date: formattedDate,
      status: 'PAID',
      headline: `Booking.com Auszahlung (${Number(exactBookingGuest.amount).toFixed(2)} €)`,
      explanation: `Booking.com-Auszahlung für Gast '${exactBookingGuest.guestName}' über ${Number(exactBookingGuest.amount).toFixed(2)} € gefunden (Auszahlungsdatum: ${payoutStr}, Ref: ${exactBookingGuest.referenceNumber}).`,
      confidence: 0.98,
      suggestedComment: `Booking.com Auszahlung #${exactBookingGuest.id} (Ref ${exactBookingGuest.referenceNumber})`,
      matchedTransactions: [
        {
          type: 'BOOKING',
          id: exactBookingGuest.id,
          amount: Number(exactBookingGuest.amount),
          date: payoutStr,
          details: `Booking.com Auszahlung für '${exactBookingGuest.guestName}' (Ref: ${exactBookingGuest.referenceNumber})`,
        },
      ],
      geminiUsed: false,
    };
  }

  // Decision 2: If Bank preferred or exact bank match found
  if (exactBankMatches.length > 0) {
    const bestBank = exactBankMatches[0];
    const bankDateStr = new Date(bestBank.bookingDate).toLocaleDateString('de-DE');
    return {
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      recipient: inv.recipient,
      amount: invAmount,
      date: formattedDate,
      status: 'PAID',
      headline: `Banküberweisung über exakt ${Number(bestBank.amount).toFixed(2)} € gefunden`,
      explanation: `Am ${bankDateStr} ging eine Überweisung über ${Number(bestBank.amount).toFixed(2)} € ein. Absender: '${bestBank.senderReceiver || 'Unbekannt'}' (Verwendungszweck: '${bestBank.description || ''}').`,
      confidence: 0.95,
      suggestedComment: `Banküberweisung von ${bestBank.senderReceiver || 'Kunde'} (${bankDateStr})`,
      matchedTransactions: [
        {
          type: 'BANK',
          id: bestBank.id,
          amount: Number(bestBank.amount),
          date: bankDateStr,
          details: `Absender: ${bestBank.senderReceiver || 'Unbekannt'} | Zweck: ${bestBank.description || ''}`,
        },
      ],
      geminiUsed: false,
    };
  }

  // Decision 3: If Card split or card match found
  if (matchedCards && matchedCards.length > 0) {
    const cardSum = matchedCards.reduce((s, c) => s + Number(c.amount), 0);
    const cardItemsStr = matchedCards.map(c => `${Number(c.amount).toFixed(2)} € (${c.cardType})`).join(' + ');
    const cardDateFormatted = new Date(matchedCardDate).toLocaleDateString('de-DE');

    return {
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      recipient: inv.recipient,
      amount: invAmount,
      date: formattedDate,
      status: 'PAID',
      headline: matchedCards.length > 1 ? `Kartenzahlung (Split: ${cardItemsStr})` : `Kartenzahlung am Terminal gefunden`,
      explanation: `Am Nexi-Terminal wurden am ${cardDateFormatted} passende Kartenzahlung(en) gefunden: ${cardItemsStr} = exakt ${cardSum.toFixed(2)} €.`,
      confidence: 0.95,
      suggestedComment: matchedCards.length > 1 ? `Terminal-Split: ${cardItemsStr}` : `Kartenzahlung ${cardItemsStr}`,
      matchedTransactions: matchedCards.map(c => ({
        type: 'CARD',
        id: c.id,
        amount: Number(c.amount),
        date: new Date(c.transactionDate).toLocaleDateString('de-DE'),
        details: `${c.cardType} am Terminal (ID #${c.id})`,
      })),
      geminiUsed: false,
    };
  }

  // Decision 4: Default: No matches -> OPEN
  return {
    invoiceId: inv.id,
    invoiceNumber: inv.invoiceNumber,
    recipient: inv.recipient,
    amount: invAmount,
    date: formattedDate,
    status: 'OPEN',
    headline: 'Kein Geldeingang gefunden (Rechnung ist unbezahlt)',
    explanation: `Weder auf den Bankkonten noch bei Kartenzahlungen oder Booking.com konnte im relevanten Zeitraum ein passender Zahlungseingang über ${invAmount.toFixed(2)} € oder für '${inv.recipient}' gefunden werden. Die Rechnung ist berechtigt offen.`,
    confidence: 0.90,
    suggestedComment: 'KI-Prüfung: Noch kein Geldeingang vorhanden',
    matchedTransactions: [],
    geminiUsed: false,
  };
}

export async function applyAiMatch(invoiceId: number, data: {
  status?: 'PAID' | 'PARTIAL';
  amountPaid?: number;
  comment?: string;
  matches: {
    type: 'CARD' | 'BANK' | 'BOOKING';
    id: number;
  }[];
}) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw new Error(`Rechnung mit ID ${invoiceId} nicht gefunden`);

  const targetAmountPaid = data.amountPaid !== undefined ? data.amountPaid : Number(inv.amount);

  return await prisma.$transaction(async (tx) => {
    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        isReconciled: true,
        reconciledDate: new Date(),
        manualStatus: true,
        status: data.status || 'PAID',
        amountPaid: targetAmountPaid,
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
