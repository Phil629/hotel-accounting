# Data Structures Analysis

Based on the provided screenshots, here are the data structures for the four main data sources.

## 1. Booking.com Payments
*   **Format**: CSV
*   **Header Row**: 1
*   **Key Columns**:
    *   `Referenznummer` (Col B): Unique identifier for the booking.
    *   `Check-in` (Col C): Date format `dd. MMM. yyyy` (e.g., 14. Okt. 2025).
    *   `Checkout` (Col D): Date format `dd. MMM. yyyy`.
    *   `Betrag` (Col I): Payment amount (e.g., 76.95).
    *   `Datum der Auszahlung` (Col J): Date format `dd. Okt. 2025`.
    *   `Auszahlungsnummer` (Col K): Reference for the payout.

## 2. Ibelsa Invoices (PMS)
*   **Format**: CSV
*   **Header Row**: 1
*   **Key Columns**:
    *   `Rechnungsdatum` (Col A): Date format `dd.MM.yyyy` (e.g., 01.09.2025).
    *   `Zahlungsart` (Col B): e.g., "Banküberweisung", "Bar", "Booking.com", "EC-Karte", "Mastercard", "Visa Electron".
    *   `Rechnungsnummer` (Col C): Format "Rechnung XXXXX / YYYY".
    *   `Rechnungsempfänger` (Col D): Name of the guest/company.
    *   `Gesamt` (Col F): Total amount (e.g., 1.500,00).

## 3. Bank Transactions (Volksbank)
*   **Format**: CSV
*   **Header Row**: 1
*   **Key Columns**:
    *   `Buchungstag` (Col E): Date format `dd.MM.yyyy` (e.g., 31.10.2025).
    *   `Verwendungszweck` (Col K): Contains text description, often including invoice numbers or booking references.
    *   `Betrag` (Col L): Transaction amount (negative for debits, positive for credits).
    *   `Name Zahlungsbeteiligter` (Col G): Name of the sender/receiver.

## 4. Nexi (Card Payments)
*   **Format**: CSV
*   **Header Row**: 1
*   **Key Columns**:
    *   `Kartenart` (Col B): e.g., "Visa", "Girocard", "Mastercard".
    *   `Transaktionsdatum` (Col C): Date format `dd.MM.yyyy`.
    *   `Transaktionszeit` (Col D): Time format `HH:mm:ss`.
    *   `Umsatz Brutto` (Col K): Gross amount.
    *   `Zahlbetrag` (Col J): Amount paid.

## Common Challenges
*   **Date Formats**: Booking.com uses a verbose German format ("14. Okt. 2025"), while others use standard "dd.MM.yyyy".
*   **Number Formats**: German decimal comma (`,`) vs. dot (`.`) needs consistent handling.
*   **Encoding**: Likely UTF-8, but needs verification for special characters (Umlaute).
