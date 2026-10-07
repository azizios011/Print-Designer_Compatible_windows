# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Parser for Banque Zitouna digital account statements (form BZ-RC-01).

The statement prints one operation per row as
"<date opération> <libellé> <date valeur> <signed amount>": a negative amount
is a débit, a positive one a crédit. Amounts use a decimal comma and no
thousands separator. Page 1 carries the account header and the opening balance
(SOLDE DEBUT); the last page carries the Totaux row and the
"Solde au <date>" closing-balance box, printed slightly below their labels.

Fields printed on the statement but absent from the releve_bancaire schema
(agence, devise, the titulaire address lines) are not emitted; the statement
carries no printed statement number, so reference_number stays null.
"""

import re
from decimal import Decimal

NAME = "banque_zitouna"

DATE_PATTERN = r"\d{2}/\d{2}/\d{4}"
AMOUNT_PATTERN = r"-?\d+,\d{3}"
ROW_PATTERN = re.compile(rf"^({DATE_PATTERN})\s+(.+?)\s+({DATE_PATTERN})\s+({AMOUNT_PATTERN})$")
OPENING_PATTERN = re.compile(rf"^SOLDE DEBUT\s+({AMOUNT_PATTERN})$")
CLOSING_PATTERN = re.compile(rf"^({DATE_PATTERN})\s*:?\s*({AMOUNT_PATTERN})$")
PERIOD_PATTERN = re.compile(rf"^({DATE_PATTERN})\D+({DATE_PATTERN})$")
AMOUNT_WORD_PATTERN = re.compile(rf"^{AMOUNT_PATTERN}$")

ROW_BUCKET_PT = 3
TOTALS_WINDOW_PT = 8
TITULAIRE_X_RATIO = 0.5


def detect(doc) -> bool:
	if doc.page_count < 1:
		return False
	text = doc[0].get_text("text")
	return "BZ-RC-01" in text or "Banque Zitouna" in text


def parse(doc) -> dict | None:
	if doc.page_count < 1:
		return None
	pages_rows = [_page_rows(page) for page in doc]
	first_rows = pages_rows[0]
	last_rows = pages_rows[-1]

	rib = iban = period_from = period_to = company = None
	rib_y = iban_y = None
	opening = None
	company_rows = []

	for row in first_rows:
		opening_match = OPENING_PATTERN.match(row["text"])
		if opening_match:
			opening = _to_decimal(opening_match.group(1))
			break
		if ROW_PATTERN.match(row["text"]):
			break
		if period_from is None:
			period_match = PERIOD_PATTERN.match(row["text"])
			if period_match:
				period_from = _to_iso_date(period_match.group(1))
				period_to = _to_iso_date(period_match.group(2))
				continue
		if rib is None:
			rib_words = _words_after_label(row, "RIB", r"\d+")
			if rib_words:
				rib = " ".join(rib_words)
				rib_y = row["y"]
				continue
		if iban is None:
			iban_words = _words_after_label(row, "IBAN", r"[A-Z0-9]+")
			if iban_words:
				iban = " ".join(iban_words)
				iban_y = row["y"]
				continue
		# the titulaire block is printed in a right-hand column below the
		# RIB/IBAN rows, next to the client letter
		if row["y"] > (rib_y or iban_y or 0) and row["x0"] > doc[0].rect.width * TITULAIRE_X_RATIO:
			company_rows.append(row["text"])
	company = company_rows[0] if company_rows else None

	entries = [
		entry
		for page_rows in pages_rows
		for row in page_rows
		if (entry := _match_entry_row(row["text"])) is not None
	]
	if not entries:
		return None

	printed_total_debit, printed_total_credit = _printed_totals(last_rows)
	printed_closing = _printed_closing(last_rows)

	sum_debit = sum((entry["debit"] for entry in entries if entry["debit"]), Decimal("0"))
	sum_credit = sum((entry["credit"] for entry in entries if entry["credit"]), Decimal("0"))
	computed_closing = opening + sum_credit - sum_debit if opening is not None else None
	balanced = (
		computed_closing is not None
		and printed_closing is not None
		and printed_total_debit is not None
		and printed_total_credit is not None
		and computed_closing == printed_closing
		and sum_debit == printed_total_debit
		and sum_credit == printed_total_credit
	)

	return {
		"data": {
			"company": company,
			"iban": iban,
			"bank_account": rib,
			"period_from": period_from,
			"period_to": period_to,
			"reference_number": None,
			"opening_balance": _to_float(opening),
			"closing_balance": _to_float(printed_closing),
			"entries": [
				{
					"date": entry["date"],
					"libelle": entry["libelle"],
					"valeur": entry["valeur"],
					"debit": _to_float(entry["debit"]),
					"credit": _to_float(entry["credit"]),
				}
				for entry in entries
			],
		},
		"checks": {
			"balanced": bool(balanced),
			"opening": _to_float(opening),
			"sum_debit": _to_float(sum_debit),
			"sum_credit": _to_float(sum_credit),
			"computed_closing": _to_float(computed_closing),
			"printed_closing": _to_float(printed_closing),
			"printed_total_debit": _to_float(printed_total_debit),
			"printed_total_credit": _to_float(printed_total_credit),
			"entry_count": len(entries),
		},
	}


def _page_rows(page) -> list[dict]:
	"""Group a page's words into visual rows (bucket of ~3pt on the vertical
	center), each sorted left to right."""
	rows = {}
	for x0, y0, x1, y1, word, *_ in page.get_text("words"):
		rows.setdefault(round(((y0 + y1) / 2) / ROW_BUCKET_PT), []).append((x0, word))
	return [
		{
			"y": bucket * ROW_BUCKET_PT,
			"x0": min(x0 for x0, _ in words),
			"text": " ".join(word for _, word in sorted(words)),
			"words": sorted(words),
		}
		for bucket, words in sorted(rows.items())
	]


def _words_after_label(row, label: str, value_pattern: str) -> list[str] | None:
	"""Words printed right of `label` in the row, while they match
	`value_pattern` (the run stops at the next label or Arabic text)."""
	words = row["words"]
	for index, (_, word) in enumerate(words):
		if word != label:
			continue
		values = []
		for _, next_word in words[index + 1 :]:
			if not re.fullmatch(value_pattern, next_word):
				break
			values.append(next_word)
		return values or None
	return None


def _match_entry_row(text: str) -> dict | None:
	match = ROW_PATTERN.match(text)
	if not match:
		return None
	amount = _to_decimal(match.group(4))
	return {
		"date": _to_iso_date(match.group(1)),
		"libelle": match.group(2).strip(),
		"valeur": _to_iso_date(match.group(3)),
		"debit": amount.copy_abs() if amount < 0 else None,
		"credit": amount if amount > 0 else None,
	}


def _printed_totals(last_rows) -> tuple[Decimal | None, Decimal | None]:
	"""Total débit and crédit printed around the Totaux label of the last
	page (the amounts sit in rows a few points above/below the label)."""
	totaux_y = next(
		(row["y"] for row in last_rows if any(word == "Totaux" for _, word in row["words"])),
		None,
	)
	if totaux_y is None:
		return None, None
	amounts = sorted(
		(x0, word)
		for row in last_rows
		if abs(row["y"] - totaux_y) <= TOTALS_WINDOW_PT
		for x0, word in row["words"]
		if AMOUNT_WORD_PATTERN.fullmatch(word)
	)
	# left column is Débit, right column is Crédit; the printed total débit
	# carries the entries' negative sign
	total_debit = _to_decimal(amounts[0][1]).copy_abs() if len(amounts) > 0 else None
	total_credit = _to_decimal(amounts[1][1]).copy_abs() if len(amounts) > 1 else None
	return total_debit, total_credit


def _printed_closing(last_rows) -> Decimal | None:
	"""Closing balance printed in the "Solde au <date>" box below the Totaux
	row of the last page."""
	label_y = next(
		(row["y"] for row in last_rows if "Solde au" in row["text"]),
		None,
	)
	for row in last_rows:
		if label_y is not None and row["y"] <= label_y:
			continue
		closing_match = CLOSING_PATTERN.match(row["text"])
		if closing_match:
			return _to_decimal(closing_match.group(2))
	return None


def _to_decimal(raw: str) -> Decimal:
	return Decimal(raw.replace(",", "."))


def _to_iso_date(raw: str) -> str:
	day, month, year = raw.split("/")
	return f"{year}-{month}-{day}"


def _to_float(value) -> float | None:
	return float(value) if value is not None else None
