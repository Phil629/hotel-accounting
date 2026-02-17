
import { parse } from 'csv-parse/sync';

const fileContent = `Type,"Reference number",Check-in,Checkout,"Guest name","Reservation status",Currency,"Payment status",Amount,"Payout date","Payout ID"
Reservation,6640998854,"10 Jun 2025","11 Jun 2025","Patrick Neurode",ok,EUR,"Paid Online",82.00,"12 Jun 2025",t0x3TKOhuxzpufmk
Reservation,6640926554,"10 Jun 2025","11 Jun 2025","Christina Linke",ok,EUR,"Paid Online",65.70,"12 Jun 2025",t0x3TKOhuxzpufmk`;

function parseDate(dateStr: string): Date | null {
    if (!dateStr) return null;
    let clean = dateStr.trim();

    // Try standard dd.MM.yyyy or dd.MM.yy
    if (clean.includes('.')) {
        const parts = clean.split('.');
        if (parts.length === 3) {
            const day = parseInt(parts[0]);
            const month = parseInt(parts[1]) - 1;
            let year = parseInt(parts[2]);
            if (year < 100) year += 2000;
            if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
                return new Date(year, month, day);
            }
        }
    }

    // Try yyyy-mm-dd
    if (clean.includes('-')) {
        const parts = clean.split('-');
        if (parts.length === 3) {
            if (parts[0].length === 4) {
                return new Date(clean);
            }
            const day = parseInt(parts[0]);
            const month = parseInt(parts[1]) - 1;
            const year = parseInt(parts[2]);
            return new Date(year, month, day);
        }
    }

    // Try verbose format (14. Okt. 2025, 9 Jun 2025)
    const months: { [key: string]: number } = {
        // German Short
        'Jan': 0, 'Feb': 1, 'Mär': 2, 'Apr': 3, 'Mai': 4, 'Jun': 5,
        'Jul': 6, 'Aug': 7, 'Sep': 8, 'Sept': 8, 'Okt': 9, 'Nov': 10, 'Dez': 11,
        // German Full
        'Januar': 0, 'Februar': 1, 'März': 2, 'April': 3, 'Juni': 5,
        'Juli': 6, 'August': 7, 'September': 8, 'Oktober': 9, 'November': 10, 'Dezember': 11,
        // English Short & Full
        'Oct': 9, 'Dec': 11, 'Mar': 2, 'May': 4,
        'January': 0, 'February': 1, 'March': 2, 'June': 5, 'July': 6, 'October': 9, 'December': 11
    };

    // Clean up the string: remove quotes, extra spaces
    clean = clean.replace(/['"]/g, '').trim();

    // Try splitting by space
    const verboseParts = clean.split(' ');
    if (verboseParts.length >= 3) {
        // Handle "9 Jun 2025" or "14. Okt. 2025"
        const dayStr = verboseParts[0].replace('.', '');
        const monthStr = verboseParts[1].replace('.', '');
        const yearStr = verboseParts[2];

        const day = parseInt(dayStr);
        const year = parseInt(yearStr);
        const month = months[monthStr];

        console.log(`Parsing verbose: ${clean} -> Day: ${day}, Month: ${monthStr} (${month}), Year: ${year}`);

        if (!isNaN(day) && month !== undefined && !isNaN(year)) {
            return new Date(year, month, day);
        }
    }

    return null;
}

function run() {
    console.log("Testing Date Parsing...");
    const date1 = parseDate("10 Jun 2025");
    console.log(`"10 Jun 2025" -> ${date1}`);

    const date2 = parseDate('"10 Jun 2025"');
    console.log(`'"10 Jun 2025"' -> ${date2}`);

    console.log("\nTesting CSV Parsing...");
    const records = parse(fileContent, { delimiter: ',', from_line: 1, relax_quotes: true });

    const header = records[0].map((col: string) => col.toLowerCase().trim());
    console.log("Header:", header);

    const colMap = {
        ref: header.findIndex((h: string) => h.includes('referenz') || h.includes('reference') || h.includes('booking number')),
        checkIn: header.findIndex((h: string) => h.includes('check-in') || h.includes('anreise')),
        checkOut: header.findIndex((h: string) => h.includes('check-out') || h.includes('abreise')),
        amount: header.findIndex((h: string) => h.includes('betrag') || h.includes('amount') || h.includes('total')),
        payout: header.findIndex((h: string) => h.includes('auszahlungsdatum') || h.includes('payout date') || h.includes('datum der auszahlung'))
    };
    console.log("ColMap:", colMap);

    const row = records[1];
    console.log("Row 1:", row);

    const checkInDate = parseDate(row[colMap.checkIn]);
    console.log("Parsed CheckIn:", checkInDate);
}

run();
