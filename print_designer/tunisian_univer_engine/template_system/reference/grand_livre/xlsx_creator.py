from __future__ import annotations

from datetime import datetime
from typing import Any

from openpyxl import Workbook
from openpyxl.styles import Border, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.pagebreak import Break

try:
    from .metadata import (
        ACC_HEADER_HEIGHT,
        ALIGN_CENTER,
        ALIGN_LEFT,
        ALIGN_LEFT_WRAP,
        ALIGN_RIGHT,
        COL_WIDTHS,
        FILL_REPORTER,
        FONT_ACC_NAME,
        FONT_COMPANY,
        FONT_DATA,
        FONT_FOOTER_LEFT,
        FONT_FOOTER_PAGE,
        FONT_HDR_BLACK,
        FONT_HDR_NAVY,
        FONT_PERIOD,
        FONT_REF,
        FONT_TITLE,
        FONT_TOTAL_LABEL,
        FONT_TOTAL_NUM,
        FULL_THIN_BORDER,
        MAX_PAGE_HEIGHT_PT,
        NUM_FMT,
        PAGE_FOOTER_HEIGHT,
        PAGE_HEADER_HEIGHT,
        PAGE_MARGINS,
        ROW_H_ACC_COLS,
        ROW_H_ACC_GAP,
        ROW_H_ACC_TITLE,
        ROW_H_ACC_TOTAL,
        ROW_H_COMPANY,
        ROW_H_ENTRY_DEFAULT,
        ROW_H_FOOTER,
        ROW_H_FOOTER_GAP,
        ROW_H_HEADER_GAP,
        ROW_H_PERIOD,
        ROW_H_REPORTER,
        THIN_SIDE,
    )
except ImportError:
    from metadata import (
        ACC_HEADER_HEIGHT,
        ALIGN_CENTER,
        ALIGN_LEFT,
        ALIGN_LEFT_WRAP,
        ALIGN_RIGHT,
        COL_WIDTHS,
        FILL_REPORTER,
        FONT_ACC_NAME,
        FONT_COMPANY,
        FONT_DATA,
        FONT_FOOTER_LEFT,
        FONT_FOOTER_PAGE,
        FONT_HDR_BLACK,
        FONT_HDR_NAVY,
        FONT_PERIOD,
        FONT_REF,
        FONT_TITLE,
        FONT_TOTAL_LABEL,
        FONT_TOTAL_NUM,
        FULL_THIN_BORDER,
        MAX_PAGE_HEIGHT_PT,
        NUM_FMT,
        PAGE_FOOTER_HEIGHT,
        PAGE_HEADER_HEIGHT,
        PAGE_MARGINS,
        ROW_H_ACC_COLS,
        ROW_H_ACC_GAP,
        ROW_H_ACC_TITLE,
        ROW_H_ACC_TOTAL,
        ROW_H_COMPANY,
        ROW_H_ENTRY_DEFAULT,
        ROW_H_FOOTER,
        ROW_H_FOOTER_GAP,
        ROW_H_HEADER_GAP,
        ROW_H_PERIOD,
        ROW_H_REPORTER,
        THIN_SIDE,
    )


# ---------------------------------------------------------------------------
# Low-level Excel helpers
# ---------------------------------------------------------------------------
def _apply_box_border(
    ws, min_col: int, min_row: int, max_col: int, max_row: int, side: Side = THIN_SIDE
) -> None:
    """Apply clean outer borders around a cell or merged cell range."""
    for r in range(min_row, max_row + 1):
        for c in range(min_col, max_col + 1):
            ws.cell(row=r, column=c).border = Border(
                left=side if c == min_col else None,
                right=side if c == max_col else None,
                top=side if r == min_row else None,
                bottom=side if r == max_row else None,
            )


def _apply_fill(ws, min_col: int, min_row: int, max_col: int, max_row: int, fill: PatternFill) -> None:
    for r in range(min_row, max_row + 1):
        for c in range(min_col, max_col + 1):
            ws.cell(row=r, column=c).fill = fill


def _estimate_entry_height(entry: dict[str, Any]) -> float:
    """Estimate row height (pt) when Libellé or Réf. wraps onto 2+ lines."""
    libelle = str(entry.get("libelle") or "")
    ref = str(entry.get("ref") or "")
    lines = max(
        1,
        (len(libelle) + 35) // 36,
        (len(ref) + 15) // 16,
    )
    return ROW_H_ENTRY_DEFAULT if lines == 1 else (11.0 * lines + 2.0)


def _write_page_header(
    ws,
    start_row: int,
    company_info: dict[str, str],
    period: dict[str, str],
) -> int:
    """Write the top company block + 'Grand Livre' + 'Du ... Au ...' and return next row."""
    company_lines = [
        company_info.get("name", ""),
        company_info.get("address", ""),
        company_info.get("country", ""),
        company_info.get("tax_id", ""),
    ]
    for offset, text in enumerate(company_lines):
        r = start_row + offset
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=3)
        cell = ws.cell(row=r, column=1, value=text)
        cell.font = FONT_COMPANY
        cell.alignment = ALIGN_LEFT
        ws.row_dimensions[r].height = ROW_H_COMPANY

    # "Grand Livre" centered across D:G alongside the 4 company lines
    ws.merge_cells(start_row=start_row, start_column=4, end_row=start_row + 3, end_column=7)
    title_cell = ws.cell(row=start_row, column=4, value="Grand Livre")
    title_cell.font = FONT_TITLE
    title_cell.alignment = ALIGN_CENTER

    # Period line centered across full width A:I
    period_row = start_row + 4
    ws.merge_cells(start_row=period_row, start_column=1, end_row=period_row, end_column=9)
    period_text = f"Du {period.get('from_date', '')} Au {period.get('to_date', '')}"
    p_cell = ws.cell(row=period_row, column=1, value=period_text)
    p_cell.font = FONT_PERIOD
    p_cell.alignment = ALIGN_CENTER
    ws.row_dimensions[period_row].height = ROW_H_PERIOD

    # Small spacer row before first table
    gap_row = start_row + 5
    ws.row_dimensions[gap_row].height = ROW_H_HEADER_GAP
    return gap_row + 1


def _write_account_header(ws, start_row: int, account: dict[str, Any]) -> int:
    """Write the 2-row account header (Code/Name + Mouvements + Solde + column names)."""
    r1 = start_row
    r2 = start_row + 1
    ws.row_dimensions[r1].height = ROW_H_ACC_TITLE
    ws.row_dimensions[r2].height = ROW_H_ACC_COLS

    ws.merge_cells(start_row=r1, start_column=1, end_row=r1, end_column=6)
    acc_cell = ws.cell(row=r1, column=1, value=f"{account['code']} {account['name']}")
    acc_cell.font = FONT_ACC_NAME
    acc_cell.alignment = ALIGN_LEFT
    _apply_box_border(ws, 1, r1, 6, r1)

    ws.merge_cells(start_row=r1, start_column=7, end_row=r1, end_column=8)
    mvt_hdr = ws.cell(row=r1, column=7, value="Mouvements")
    mvt_hdr.font = FONT_HDR_NAVY
    mvt_hdr.alignment = ALIGN_CENTER
    _apply_box_border(ws, 7, r1, 8, r1)

    ws.merge_cells(start_row=r1, start_column=9, end_row=r2, end_column=9)
    solde_hdr = ws.cell(row=r1, column=9, value="Solde")
    solde_hdr.font = FONT_HDR_NAVY
    solde_hdr.alignment = ALIGN_CENTER
    _apply_box_border(ws, 9, r1, 9, r2)

    c_date = ws.cell(row=r2, column=1, value="Date")
    c_date.font = FONT_HDR_BLACK
    c_date.alignment = ALIGN_CENTER
    c_date.border = FULL_THIN_BORDER

    c_mvt = ws.cell(row=r2, column=2, value="Mvt")
    c_mvt.font = FONT_HDR_BLACK
    c_mvt.alignment = ALIGN_CENTER
    c_mvt.border = FULL_THIN_BORDER

    ws.merge_cells(start_row=r2, start_column=3, end_row=r2, end_column=4)
    c_lib = ws.cell(row=r2, column=3, value="Libellé écriture")
    c_lib.font = FONT_HDR_BLACK
    c_lib.alignment = ALIGN_CENTER
    _apply_box_border(ws, 3, r2, 4, r2)

    c_jrn = ws.cell(row=r2, column=5, value="Jrn")
    c_jrn.font = FONT_HDR_BLACK
    c_jrn.alignment = ALIGN_CENTER
    c_jrn.border = FULL_THIN_BORDER

    c_ref = ws.cell(row=r2, column=6, value="Réf.")
    c_ref.font = FONT_HDR_BLACK
    c_ref.alignment = ALIGN_CENTER
    c_ref.border = FULL_THIN_BORDER

    c_deb = ws.cell(row=r2, column=7, value="Débit")
    c_deb.font = FONT_HDR_NAVY
    c_deb.alignment = ALIGN_CENTER
    c_deb.border = FULL_THIN_BORDER

    c_crd = ws.cell(row=r2, column=8, value="Crédit")
    c_crd.font = FONT_HDR_NAVY
    c_crd.alignment = ALIGN_CENTER
    c_crd.border = FULL_THIN_BORDER

    return r2 + 1


def _write_entry_row(
    ws, row_idx: int, entry: dict[str, Any], running_solde: float, row_height: float
) -> int:
    """Write one ledger transaction row."""
    ws.row_dimensions[row_idx].height = row_height

    c1 = ws.cell(row=row_idx, column=1, value=entry.get("date", ""))
    c1.font = FONT_DATA
    c1.alignment = ALIGN_CENTER
    c1.border = FULL_THIN_BORDER

    c2 = ws.cell(row=row_idx, column=2, value=entry.get("mvt", ""))
    c2.font = FONT_DATA
    c2.alignment = ALIGN_CENTER
    c2.border = FULL_THIN_BORDER

    ws.merge_cells(start_row=row_idx, start_column=3, end_row=row_idx, end_column=4)
    c3 = ws.cell(row=row_idx, column=3, value=entry.get("libelle", ""))
    c3.font = FONT_DATA
    c3.alignment = ALIGN_LEFT_WRAP
    _apply_box_border(ws, 3, row_idx, 4, row_idx)

    c5 = ws.cell(row=row_idx, column=5, value=entry.get("jrn", ""))
    c5.font = FONT_DATA
    c5.alignment = ALIGN_CENTER
    c5.border = FULL_THIN_BORDER

    c6 = ws.cell(row=row_idx, column=6, value=entry.get("ref", ""))
    c6.font = FONT_REF
    c6.alignment = ALIGN_LEFT_WRAP
    c6.border = FULL_THIN_BORDER

    debit = float(entry.get("debit") or 0.0)
    credit = float(entry.get("credit") or 0.0)

    c7 = ws.cell(row=row_idx, column=7, value=debit if debit != 0 else None)
    c7.font = FONT_DATA
    c7.alignment = ALIGN_RIGHT
    c7.number_format = NUM_FMT
    c7.border = FULL_THIN_BORDER

    c8 = ws.cell(row=row_idx, column=8, value=credit if credit != 0 else None)
    c8.font = FONT_DATA
    c8.alignment = ALIGN_RIGHT
    c8.number_format = NUM_FMT
    c8.border = FULL_THIN_BORDER

    c9 = ws.cell(row=row_idx, column=9, value=running_solde)
    c9.font = FONT_DATA
    c9.alignment = ALIGN_RIGHT
    c9.number_format = NUM_FMT
    c9.border = FULL_THIN_BORDER

    return row_idx + 1


def _write_account_total_row(
    ws,
    row_idx: int,
    account: dict[str, Any],
    period: dict[str, str],
    acc_debit: float,
    acc_credit: float,
    acc_solde: float,
) -> int:
    """Write the 'Total Compte : XXXX' summary row."""
    ws.row_dimensions[row_idx].height = ROW_H_ACC_TOTAL

    ws.merge_cells(start_row=row_idx, start_column=1, end_row=row_idx, end_column=6)
    lbl = f"Total Compte : {account['code']}\ndu {period.get('from_date', '')} Au {period.get('to_date', '')}"
    c_lbl = ws.cell(row=row_idx, column=1, value=lbl)
    c_lbl.font = FONT_TOTAL_LABEL
    c_lbl.alignment = ALIGN_LEFT_WRAP
    _apply_box_border(ws, 1, row_idx, 6, row_idx)

    c_deb = ws.cell(row=row_idx, column=7, value=acc_debit if acc_debit != 0 else None)
    c_deb.font = FONT_TOTAL_NUM
    c_deb.alignment = ALIGN_RIGHT
    c_deb.number_format = NUM_FMT
    c_deb.border = FULL_THIN_BORDER

    c_crd = ws.cell(row=row_idx, column=8, value=acc_credit if acc_credit != 0 else None)
    c_crd.font = FONT_TOTAL_NUM
    c_crd.alignment = ALIGN_RIGHT
    c_crd.number_format = NUM_FMT
    c_crd.border = FULL_THIN_BORDER

    c_sol = ws.cell(row=row_idx, column=9, value=acc_solde)
    c_sol.font = FONT_TOTAL_NUM
    c_sol.alignment = ALIGN_RIGHT
    c_sol.number_format = NUM_FMT
    c_sol.border = FULL_THIN_BORDER

    return row_idx + 1


def _write_page_footer(
    ws,
    row_idx: int,
    cum_debit: float,
    cum_credit: float,
    cum_solde: float,
    generated_at: str,
    page_footer_rows: list[int],
) -> int:
    """Write the 'A reporter' bar + Date de tirage & Page X/Y row right below the content."""
    ws.row_dimensions[row_idx].height = ROW_H_FOOTER_GAP
    rep_row = row_idx + 1
    ws.row_dimensions[rep_row].height = ROW_H_REPORTER

    ws.merge_cells(start_row=rep_row, start_column=1, end_row=rep_row, end_column=6)
    c_lbl = ws.cell(row=rep_row, column=1, value="A reporter")
    c_lbl.font = FONT_TOTAL_LABEL
    c_lbl.alignment = ALIGN_LEFT
    _apply_fill(ws, 1, rep_row, 6, rep_row, FILL_REPORTER)
    _apply_box_border(ws, 1, rep_row, 6, rep_row)

    for col_idx, val in [(7, cum_debit), (8, cum_credit), (9, cum_solde)]:
        cell = ws.cell(row=rep_row, column=col_idx, value=val)
        cell.font = FONT_TOTAL_NUM
        cell.alignment = ALIGN_RIGHT
        cell.number_format = NUM_FMT
        cell.fill = FILL_REPORTER
        cell.border = FULL_THIN_BORDER

    gap2_row = rep_row + 1
    ws.row_dimensions[gap2_row].height = ROW_H_FOOTER_GAP

    pg_row = gap2_row + 1
    ws.row_dimensions[pg_row].height = ROW_H_FOOTER

    ws.merge_cells(start_row=pg_row, start_column=1, end_row=pg_row, end_column=5)
    c_dt = ws.cell(row=pg_row, column=1, value=f"Date de tirage {generated_at}")
    c_dt.font = FONT_FOOTER_LEFT
    c_dt.alignment = ALIGN_LEFT

    ws.merge_cells(start_row=pg_row, start_column=8, end_row=pg_row, end_column=9)
    c_pg = ws.cell(row=pg_row, column=8, value="")  # Populated in Pass 2 with "Page X/Y"
    c_pg.font = FONT_FOOTER_PAGE
    c_pg.alignment = ALIGN_RIGHT

    page_footer_rows.append(pg_row)
    return pg_row + 1


# ---------------------------------------------------------------------------
# Main public builder (wire this directly in Frappe/ERPNext)
# ---------------------------------------------------------------------------
def build_grand_livre_workbook(
    company_info: dict[str, str],
    period: dict[str, str],
    accounts: list[dict[str, Any]],
    generated_at: str | None = None,
    paginate_for_pdf: bool = True,
) -> Workbook:
    """
    Build an Excel Workbook styled like the Grand Livre PDF, with tight page fill
    and visible pagination (Page X/Y) in both XLSX and PDF views.
    """
    if generated_at is None:
        generated_at = datetime.now().strftime("%d/%m/%Y à %H:%M:%S")

    wb = Workbook()
    ws = wb.active
    ws.title = "Grand Livre"

    for col_idx, width in COL_WIDTHS.items():
        ws.column_dimensions[get_column_letter(col_idx)].width = width

    # View & Print / PDF settings
    ws.views.sheetView[0].showGridLines = False
    ws.print_options.gridLines = False
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.orientation = ws.ORIENTATION_PORTRAIT
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0

    ws.page_margins.left = PAGE_MARGINS["left"]
    ws.page_margins.right = PAGE_MARGINS["right"]
    ws.page_margins.top = PAGE_MARGINS["top"]
    ws.page_margins.bottom = PAGE_MARGINS["bottom"]
    ws.page_margins.header = PAGE_MARGINS["header"]
    ws.page_margins.footer = PAGE_MARGINS["footer"]

    body_budget_pt = MAX_PAGE_HEIGHT_PT - PAGE_HEADER_HEIGHT - PAGE_FOOTER_HEIGHT
    current_row = 1
    used_body_pt = 0.0

    cum_debit = 0.0
    cum_credit = 0.0
    cum_solde = 0.0
    page_footer_rows: list[int] = []

    def start_new_page() -> None:
        nonlocal current_row, used_body_pt
        current_row = _write_page_footer(
            ws, current_row, cum_debit, cum_credit, cum_solde, generated_at, page_footer_rows
        )
        ws.row_breaks.append(Break(id=current_row - 1))
        current_row = _write_page_header(ws, current_row, company_info, period)
        used_body_pt = 0.0

    current_row = _write_page_header(ws, current_row, company_info, period)
    if not paginate_for_pdf:
        ws.print_title_rows = "1:5"

    for acc in accounts:
        entries = acc.get("entries", [])
        acc_solde = float(acc.get("opening_solde") or 0.0)
        acc_debit = 0.0
        acc_credit = 0.0

        first_row_h = _estimate_entry_height(entries[0]) if entries else ROW_H_ACC_TOTAL
        if paginate_for_pdf and (used_body_pt + ACC_HEADER_HEIGHT + first_row_h > body_budget_pt):
            start_new_page()

        current_row = _write_account_header(ws, current_row, acc)
        used_body_pt += ACC_HEADER_HEIGHT

        for entry in entries:
            row_h = _estimate_entry_height(entry)
            if paginate_for_pdf and (used_body_pt + row_h > body_budget_pt):
                start_new_page()
                current_row = _write_account_header(ws, current_row, acc)
                used_body_pt += ACC_HEADER_HEIGHT

            debit = float(entry.get("debit") or 0.0)
            credit = float(entry.get("credit") or 0.0)
            acc_debit += debit
            acc_credit += credit
            acc_solde += debit - credit

            cum_debit += debit
            cum_credit += credit
            cum_solde += debit - credit

            current_row = _write_entry_row(ws, current_row, entry, acc_solde, row_h)
            used_body_pt += row_h

        if paginate_for_pdf and (used_body_pt + ROW_H_ACC_TOTAL > body_budget_pt):
            start_new_page()
            current_row = _write_account_header(ws, current_row, acc)
            used_body_pt += ACC_HEADER_HEIGHT

        current_row = _write_account_total_row(
            ws, current_row, acc, period, acc_debit, acc_credit, acc_solde
        )
        used_body_pt += ROW_H_ACC_TOTAL

        ws.row_dimensions[current_row].height = ROW_H_ACC_GAP
        current_row += 1
        used_body_pt += ROW_H_ACC_GAP

    _write_page_footer(
        ws, current_row, cum_debit, cum_credit, cum_solde, generated_at, page_footer_rows
    )

    total_pages = len(page_footer_rows)
    for page_num, r_idx in enumerate(page_footer_rows, start=1):
        ws.cell(row=r_idx, column=8).value = f"Page {page_num}/{total_pages}"

    return wb


# ---------------------------------------------------------------------------
# Sample runner to test design & pagination on Windows
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    sample_company = {
        "name": "SOCIETE CPR AUTO",
        "address": "05 RTE TUNIS ZAGHOUEN",
        "country": "Tunisie",
        "tax_id": "1390565LBC000",
    }
    sample_period = {"from_date": "01/01/2026", "to_date": "31/01/2026"}

    long_entries = [
        {
            "date": f"{(i % 28) + 1:02d}/01/2026",
            "mvt": 100 + i,
            "libelle": f"FAC FOURNISSEUR ARTICLE #{i + 1}",
            "jrn": "AC",
            "ref": f"FAC-2026-{i + 1:05d}",
            "debit": 1250.500 if i % 5 == 0 else 0.0,
            "credit": 0.0 if i % 5 == 0 else 3420.125,
        }
        for i in range(42)
    ]

    sample_accounts = [
        {
            "code": "108000",
            "name": "CPT D'EXPLOIT.",
            "entries": [
                {"date": "06/01/2026", "mvt": 22, "libelle": "FACT STBG", "jrn": "AC", "ref": "9606606250", "debit": 0, "credit": 11.400},
                {"date": "06/01/2026", "mvt": 107, "libelle": "FAC STE MHIRI", "jrn": "AC", "ref": "FC000144", "debit": 0, "credit": 5700.891},
                {"date": "23/01/2026", "mvt": 110, "libelle": "FAC LE MOTEUR DIESEL", "jrn": "AC", "ref": "SAVFAC-26/0271", "debit": 0, "credit": 511.440},
            ],
        },
        {
            "code": "401001",
            "name": "STBG",
            "entries": [
                {"date": "01/01/2026", "mvt": 20, "libelle": "FACT STBG", "jrn": "AC", "ref": "9606605634", "debit": 0, "credit": 13348.562},
                {"date": "06/01/2026", "mvt": 22, "libelle": "FACT STBG", "jrn": "AC", "ref": "9606606250", "debit": 11.400, "credit": 0},
                {"date": "15/01/2026", "mvt": 21, "libelle": "FACT STBG", "jrn": "AC", "ref": "9606608497", "debit": 0, "credit": 10980.117},
            ],
        },
        {
            "code": "401108",
            "name": "STE MHIRI PRODUCTION",
            "entries": [
                {"date": "06/01/2026", "mvt": 107, "libelle": "FAC STE MHIRI", "jrn": "AC", "ref": "FC000144", "debit": 5700.891, "credit": 0},
                {"date": "06/01/2026", "mvt": 107, "libelle": "FAC STE MHIRI", "jrn": "AC", "ref": "FC000144", "debit": 0, "credit": 5700.891},
            ],
        },
        {
            "code": "607003",
            "name": "ACHATS 19%",
            "entries": long_entries,
        },
    ]

    wb = build_grand_livre_workbook(sample_company, sample_period, sample_accounts)
    wb.save("grand_livre_test.xlsx")
    print("Saved grand_livre_test.xlsx")