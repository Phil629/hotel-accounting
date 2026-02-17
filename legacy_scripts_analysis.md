# Legacy Google Apps Scripts Analysis

## Overview
The current system uses Google Apps Scripts to automate the import and reconciliation of hotel financial data. Data sources include Ibelsa (PMS), Booking.com, NEXI (Credit Cards), and Bank transfers. The central repository is a Google Sheet.

## Script Logic Breakdown

### 1. Data Import

#### `importLatestInvoices` (Bank & Ibelsa)
*   **Source**: Google Drive Folder.
*   **Trigger**: Manual or Time-driven (implied).
*   **Logic**:
    *   Finds the latest CSV file in a specific folder.
    *   Parses CSV manually (custom parser handling delimiters).
    *   **Bank**: Appends data to 'Bank' sheet. Sorts by date (descending).
    *   **Ibelsa**: Appends data to 'IBELSA' sheet.
    *   **Archiving**: Moves processed CSV to an Archive folder.

#### `importLatestCSV` (NEXI - Credit Cards)
*   **Source**: Google Drive Folder.
*   **Logic**:
    *   Detects delimiter (`;`, `\t`, or `,`).
    *   Reads CSV and filters out empty rows.
    *   Checks against existing data in 'Nexi' sheet to avoid duplicates (based on date/content).
    *   Merges new data with existing data.
    *   Sorts by date (descending).
    *   **Archiving**: Moves processed file to Archive.

#### `importLatestBookingPayments` (Booking.com)
*   **Source**: Google Drive Folder.
*   **Logic**:
    *   Parses CSV.
    *   Filters duplicates based on Reference Number (Column B).
    *   Sorts by Date (Column J).
    *   **Formatting**: Converts date strings to Date objects (custom parser for German/English months). Cleans amount strings (removes '€', replaces '.' with ',').
    *   Writes to 'BookingPayments' sheet.
    *   **Archiving**: Moves processed file to Archive.

### 2. Data Processing & Consolidation

#### `erstelleMonatsRechnungen` (Create Monthly Invoices)
*   **Source**: 'IBELSA' sheet.
*   **Logic**:
    *   Groups invoices by month (based on Column A date).
    *   Creates a new sheet per month (e.g., "Alle Rechnungen März 2025").
    *   Copies data and adds a "Bestätigt" (Confirmed) checkbox column.
    *   **Formatting**: Adds Conditional Formatting to highlight row green if checkbox is checked.

### 3. Reconciliation (Abgleich)

#### `rechnungenAbgleichen` (Booking & NEXI)
*   **Target**: Sheets starting with "Alle Rechnungen".
*   **Logic**:
    *   Iterates through each invoice row.
    *   **Booking.com**:
        *   Matches if Payment Type is "Booking.com".
        *   Compares with 'BookingPayments' data.
        *   **Match Criteria**: Amount matches (< 0.01 diff) AND (CheckIn OR CheckOut date is within 2 days of Invoice Date).
    *   **NEXI**:
        *   Matches if Payment Type includes "ec-karte", "visa", "mastercard".
        *   Compares with 'Nexi' data.
        *   **Match Criteria**: Card type matches (mapped) AND Amount matches AND Date within 2 days.
    *   **Action**: Marks row green (`#b6d7a8`) if matched.

#### `rechnungenAbgleichenBank` (Bank Transfers)
*   **Target**: Sheets starting with "Alle Rechnungen".
*   **Logic**:
    *   Iterates through invoice rows where Payment Type includes "Banküberweisung".
    *   Extracts 5-digit Invoice Number from Invoice Text (Regex: `Rechnung\s(\d{5})`).
    *   Compares with 'Bank' sheet data.
    *   **Match Criteria**: Amount matches AND Invoice Number found in Bank Transaction Description (Verwendungszweck).
    *   **Action**: Marks row green if matched.

## Key Observations
*   **Manual Parsing**: Heavy reliance on custom CSV parsing, likely due to format inconsistencies.
*   **Date Handling**: Complex date parsing logic suggests varying date formats across exports.
*   **Fuzzy Matching**: Reconciliation relies on date tolerances (+/- 2 days) and string matching (Payment types).
*   **State Management**: "State" is maintained via row colors (Green = Reconciled) and folder location (Archived files).
