import { defineStore } from "pinia";
import { createUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import UniverPresetSheetsCoreEnUS from "@univerjs/preset-sheets-core/locales/en-US";
import "@univerjs/preset-sheets-core/lib/index.css";

// The Univer instance must not live in reactive state: Vue's proxies break it,
// so it is kept as module-level variables instead.
let univer = null;
let univerAPI = null;

const NUMBER_FORMAT_PATTERN = "#,##0.000";
const NUMBER_FORMAT_FIELDS = ["debit", "credit", "opening_balance", "closing_balance"];

const humanizeKey = (key) =>
	key
		.replace(/_/g, " ")
		.replace(/\b\w/g, (character) => character.toUpperCase());

export const useUniverStore = defineStore("UniverStore", {
	state: () => ({
		/**
		 * @type {'releve_bancaire'|'releve_vente'|null} docType
		 */
		docType: null,
		schema: null,
		extracted: null,
		loading: false,
		error: null,
	}),
	actions: {
		async extractFromAttachment(attachment, docType) {
			this.docType = docType;
			this.schema = null;
			this.extracted = null;
			this.error = null;
			this.loading = true;
			try {
				const schemaResult = await frappe.call({
					method: "print_designer.tunisian_univer_engine.api.get_schema",
					args: { doc_type: docType },
				});
				const schemaMessage = schemaResult?.message;
				if (!schemaMessage?.success) {
					this.error = schemaMessage?.error || "Could not load the document schema.";
					frappe.msgprint({
						message: this.error,
						indicator: "red",
						title: __("Univer"),
					});
					return null;
				}
				this.schema = schemaMessage.schema;
				const extractResult = await frappe.call({
					method: "print_designer.tunisian_univer_engine.api.extract_document",
					args: { attachment, doc_type: docType },
				});
				const extractMessage = extractResult?.message;
				if (extractMessage?.success) {
					this.extracted = extractMessage.data;
					return this.extracted;
				}
				this.error = extractMessage?.error || "Could not extract the document data.";
				frappe.msgprint({
					message: this.error,
					indicator: "red",
					title: __("Univer"),
				});
				return null;
			} catch (error) {
				this.error = error?.message ? String(error.message) : String(error);
				frappe.msgprint({
					message: this.error,
					indicator: "red",
					title: __("Univer"),
				});
				return null;
			} finally {
				this.loading = false;
			}
		},
		buildWorkbook(docType, data) {
			data = data || {};
			const schema = this.schema || {};
			const headerKeys = Object.keys(schema).filter((key) => key != "entries");
			if (!headerKeys.length && data && typeof data == "object") {
				// fall back to the extracted data when the schema could not be loaded
				Object.keys(data).forEach((key) => {
					if (key != "entries") headerKeys.push(key);
				});
			}
			const entryKeys = Array.isArray(schema.entries) && schema.entries.length
				? Object.keys(schema.entries[0])
				: Array.isArray(data.entries) && data.entries.length
					? Object.keys(data.entries[0])
					: [];
			const cellData = {};
			let rowIndex = 0;
			const setCell = (row, column, value, style) => {
				if (value === null || value === undefined || value === "") {
					if (!style) return;
				}
				if (!cellData[row]) cellData[row] = {};
				const cell = {};
				if (value !== null && value !== undefined && value !== "") {
					cell.v = value;
				}
				if (style) cell.s = style;
				cellData[row][column] = cell;
			};
			// header fields as label/value rows, one per non-entries schema key
			headerKeys.forEach((key) => {
				setCell(rowIndex, 0, humanizeKey(key));
				setCell(rowIndex, 1, data[key]);
				rowIndex++;
			});
			// one blank row between the header fields and the entries table
			rowIndex++;
			entryKeys.forEach((key, columnIndex) => {
				setCell(rowIndex, columnIndex, humanizeKey(key), { bold: 1 });
			});
			rowIndex++;
			const entries = Array.isArray(data.entries) ? data.entries : [];
			entries.forEach((entry) => {
				entryKeys.forEach((key, columnIndex) => {
					const value = entry ? entry[key] : null;
					const style =
						NUMBER_FORMAT_FIELDS.includes(key) || typeof value == "number"
							? { n: { pattern: NUMBER_FORMAT_PATTERN } }
							: null;
					setCell(rowIndex, columnIndex, value, style);
				});
				rowIndex++;
			});
			const sheetId = "extracted-data";
			return {
				name: docType ? `Extraction: ${docType}` : "Extraction",
				styles: {},
				sheetOrder: [sheetId],
				sheets: {
					[sheetId]: {
						id: sheetId,
						name: "Extracted Data",
						rowCount: Math.max(rowIndex + 50, 100),
						columnCount: Math.max(entryKeys.length + 5, 10),
						cellData,
					},
				},
			};
		},
		mount(containerId) {
			if (univer) {
				this.destroy();
			}
			const { univer: univerInstance, univerAPI: univerAPIInstance } = createUniver({
				locale: LocaleType.EN_US,
				locales: { [LocaleType.EN_US]: mergeLocales(UniverPresetSheetsCoreEnUS) },
				presets: [UniverSheetsCorePreset({ container: containerId })],
			});
			univer = univerInstance;
			univerAPI = univerAPIInstance;
			return univerAPI;
		},
		destroy() {
			univer?.dispose();
			univer = null;
			univerAPI = null;
		},
	},
});
