from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

# ---------------------------------------------------------------------------
# Colors, fonts & number formatting
# ---------------------------------------------------------------------------
FONT_FAMILY = "Arial"
NAVY = "000080"
BLACK = "000000"
REPORTER_BG = "B8B8E6"
NUM_FMT = "#,##0.000"  # Uses OS/LibreOffice locale (e.g. "13 348,562" in fr_TN/fr_FR)

THIN_SIDE = Side(style="thin", color=BLACK)
FULL_THIN_BORDER = Border(left=THIN_SIDE, right=THIN_SIDE, top=THIN_SIDE, bottom=THIN_SIDE)

FONT_COMPANY = Font(name=FONT_FAMILY, size=9.5, bold=True, color=BLACK)
FONT_TITLE = Font(name=FONT_FAMILY, size=18, bold=False, color=NAVY)
FONT_PERIOD = Font(name=FONT_FAMILY, size=9.5, bold=True, color=BLACK)

FONT_ACC_NAME = Font(name=FONT_FAMILY, size=10, italic=True, color=BLACK)
FONT_HDR_NAVY = Font(name=FONT_FAMILY, size=9.5, bold=False, color=NAVY)
FONT_HDR_BLACK = Font(name=FONT_FAMILY, size=9.5, bold=False, color=BLACK)

FONT_DATA = Font(name=FONT_FAMILY, size=8, bold=False, color=BLACK)
FONT_REF = Font(name=FONT_FAMILY, size=7, bold=False, color=BLACK)

FONT_TOTAL_LABEL = Font(name=FONT_FAMILY, size=8.5, bold=True, italic=True, color=BLACK)
FONT_TOTAL_NUM = Font(name=FONT_FAMILY, size=8.5, bold=True, color=BLACK)

FONT_FOOTER_LEFT = Font(name=FONT_FAMILY, size=8, bold=False, color=BLACK)
FONT_FOOTER_PAGE = Font(name=FONT_FAMILY, size=8, bold=True, color=BLACK)

FILL_REPORTER = PatternFill(fill_type="solid", start_color=REPORTER_BG, end_color=REPORTER_BG)

# ---------------------------------------------------------------------------
# Alignments
# ---------------------------------------------------------------------------
ALIGN_LEFT = Alignment(horizontal="left", vertical="center")
ALIGN_LEFT_WRAP = Alignment(horizontal="left", vertical="center", wrap_text=True)
ALIGN_CENTER = Alignment(horizontal="center", vertical="center")
ALIGN_RIGHT = Alignment(horizontal="right", vertical="center")

# ---------------------------------------------------------------------------
# Column widths (9 physical columns; C+D merged as "Libellé écriture")
# ---------------------------------------------------------------------------
COL_WIDTHS = {
    1: 10.5,  # A: Date
    2: 5.5,   # B: Mvt
    3: 15.0,  # C: Libellé écriture (left half)
    4: 22.0,  # D: Libellé écriture (right half)
    5: 4.5,   # E: Jrn
    6: 14.5,  # F: Réf.
    7: 12.5,  # G: Débit
    8: 12.5,  # H: Crédit
    9: 13.5,  # I: Solde
}

# ---------------------------------------------------------------------------
# Page setup, margins & row heights (A4 Portrait, fitToWidth=1)
# ---------------------------------------------------------------------------
PAGE_MARGINS = {
    "left": 0.22,
    "right": 0.22,
    "top": 0.22,
    "bottom": 0.25,
    "header": 0.10,
    "footer": 0.10,
}

ROW_H_COMPANY = 14.0
ROW_H_PERIOD = 16.0
ROW_H_HEADER_GAP = 8.0

ROW_H_ACC_TITLE = 17.0
ROW_H_ACC_COLS = 16.0
ROW_H_ENTRY_DEFAULT = 14.0
ROW_H_ACC_TOTAL = 26.0
ROW_H_ACC_GAP = 8.0

ROW_H_FOOTER_GAP = 4.0
ROW_H_REPORTER = 18.0
ROW_H_FOOTER = 14.0

PAGE_HEADER_HEIGHT = (4 * ROW_H_COMPANY) + ROW_H_PERIOD + ROW_H_HEADER_GAP      # 80.0 pt
PAGE_FOOTER_HEIGHT = (2 * ROW_H_FOOTER_GAP) + ROW_H_REPORTER + ROW_H_FOOTER     # 40.0 pt
ACC_HEADER_HEIGHT = ROW_H_ACC_TITLE + ROW_H_ACC_COLS                            # 33.0 pt
MAX_PAGE_HEIGHT_PT = 910.0  # Fills ~93% of A4 page cleanly without overflowing