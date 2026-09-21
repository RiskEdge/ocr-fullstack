import { useState, useMemo, useEffect, useRef, Fragment } from 'react';
import { useBehaviorTracker } from '@/hooks/useBehaviorTracker';
import {
	recordFlagExposure,
	recordDismissal,
	recordInvestigation,
	recordFieldCorrection,
	getFieldHints,
	getUserProfile,
	updateUserPreferences,
} from '@/lib/profilesApi';
import type { FieldHint } from '@/lib/profilesApi';
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow as UITableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import CatalogSearch from '@/components/CatalogSearch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
	CheckCircle2,
	XCircle,
	AlertCircle,
	ChevronDown,
	ChevronRight,
	Info,
	Wand2,
	HelpCircle,
	Layers,
	Download,
	Pencil,
	Calculator,
	Sparkles,
	Search,
} from 'lucide-react';
import type {
	ValidatedItem,
	Discrepancy,
	DerivedField,
	ValidationResult,
	PluOption,
} from '@/lib/validateApi';

const FIELD_LABELS: Record<string, string> = {
	cost_price: 'Cost Price',
	mrp: 'MRP',
	// Canonical invoice-side names, as normalised by the backend. Without these
	// the table headers and discrepancy rows read "Gst Percent" / "Sku
	// Description".
	gst_percent: 'Tax %',
	sku_description: 'Product Name',
	// Catalog-side and pre-normalisation spellings of the same two fields.
	tax_pct: 'Tax %',
	ean_code: 'EAN Code',
	product_name: 'Product Name',
	sku_desc: 'Product Name',
	quantity: 'Qty',
	plu_code: 'PLU',
	invoice_price: 'Invoice Price',
	taxable_value: 'Taxable Value',
	sgst_amount: 'SGST',
	cgst_amount: 'CGST',
	igst_amount: 'IGST',
	gst_amount: 'GST Amount',
	uom: 'UOM',
	uom_qty: 'UOM Qty',
	invoice_price_incl: 'Rate (Incl. Tax)',
	discount_pct: 'Disc %',
	discount_amount: 'Disc Amount',
	scheme_amount: 'Scheme Amount',
};

// The item keys a comparison field can arrive under. The backend normalises
// OCR headers, but older cached runs and the raw extraction both use variants,
// so every lookup tries them in order.
const INVOICE_KEYS: Record<string, string[]> = {
	sku_description: ['sku_description', 'sku_desc', 'product_name'],
	gst_percent: ['gst_percent', 'tax_pct'],
	ean_code: ['ean_code', 'ean'],
};

/**
 * What the invoice actually says for a comparison field.
 *
 * Discrepancies carry their own `actual`, but Gemini returns null for a field
 * it could not read and a field with no discrepancy has no row at all — in
 * both cases the item itself still holds the value, so the comparison tables
 * fall back to it rather than showing a dash.
 */
function invoiceValueFor(item: ValidatedItem, field: string): unknown {
	for (const key of INVOICE_KEYS[field] ?? [field]) {
		const val = item[key];
		if (val !== undefined && val !== null && val !== '') return val;
	}
	return undefined;
}

function fieldLabel(field: string): string {
	return FIELD_LABELS[field] ?? field.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Columns whose values are identifiers, not quantities: plu_code, sku_code,
// ean_code, item_code, hsn_code, barcode, or a bare plu / sku / ean.
const CODE_COLUMN_RE = /^(?:.*_)?(?:code|plu|sku|ean|hsn|upc|gtin|barcode)$/i;

/**
 * A digit-only code written to CSV as a bare number loses its leading zeros
 * the moment Excel opens the file ("00565701" becomes 565701, and a 13-digit
 * EAN becomes 8.9E+12). Wrapping it as the formula ="00565701" is the CSV
 * convention every spreadsheet honours: the cell evaluates to the exact
 * text, digits intact. Anything not purely numeric is left as-is.
 */
export function csvTextCell(value: string): string {
	return /^\d+$/.test(value) ? `="${value}"` : value;
}

function formatCellValue(val: unknown): string {
	if (val === null || val === undefined) return '—';
	if (Array.isArray(val)) return val.map((v) => String(v ?? '')).join(', ');
	if (typeof val === 'object') return '—';
	return String(val);
}

// A discrepancy is resolved when the user has explicitly accepted a value for the field.
function isResolved(d: Discrepancy, accepted: Set<string> | undefined): boolean {
	return accepted?.has(d.field) ?? false;
}

function num(val: unknown): number | null {
	if (val === null || val === undefined || val === '') return null;
	const n = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
	return isNaN(n) ? null : n;
}

function normUom(val: unknown): string {
	const letters = String(val ?? '')
		.replace(/[^A-Za-z]/g, '')
		.toUpperCase();
	return letters.endsWith('ES') ? letters.slice(0, -2) : letters.replace(/S$/, '');
}

// Discount columns as the backend normalises them, plus the raw spellings an
// older cached run may still carry. A bare "disc"/"discount" is an amount,
// matching the backend's reading of a header with neither a % nor "amount".
const DISCOUNT_PCT_CANDIDATES = [
	'discount_pct',
	'discountpct',
	'discpct',
	'discountpercent',
	'discpercent',
	'discountrate',
	'cd',
	'cdpct',
	'cashdiscount',
	'cashdiscountpct',
];
const DISCOUNT_AMOUNT_CANDIDATES = [
	'discount_amount',
	'discountamount',
	'discountamt',
	'discamount',
	'discamt',
	'discount',
	'disc',
];
const SCHEME_AMOUNT_CANDIDATES = [
	'scheme_amount',
	'schemeamount',
	'schemeamt',
	'scheme',
	'schemes',
];

interface LineDiscount {
	pct: number | null;
	amount: number | null;
	scheme: number | null;
}

/**
 * The discounts printed on a line, or null when it carries none — so an
 * undiscounted line takes exactly the path it always has. Mirrors the
 * backend's _line_discount().
 */
function lineDiscount(item: Record<string, unknown>): LineDiscount | null {
	const positive = (candidates: string[]): number | null => {
		const hit = findFieldOrdered(item, candidates);
		return hit && hit.value > 0 ? hit.value : null;
	};
	const disc: LineDiscount = {
		pct: positive(DISCOUNT_PCT_CANDIDATES),
		amount: positive(DISCOUNT_AMOUNT_CANDIDATES),
		scheme: positive(SCHEME_AMOUNT_CANDIDATES),
	};
	return disc.pct !== null || disc.amount !== null || disc.scheme !== null ? disc : null;
}

/**
 * To the paisa. An invoice is written in two-decimal currency and totalled from
 * those written figures, so every figure this file computes has to be put on
 * that same grid before it is summed with another — see `computedTaxable`.
 */
function round2(value: number): number {
	return parseFloat(value.toFixed(2));
}

/**
 * `unitPrice` with the line's discounts taken off. Rupee discounts are printed
 * per line and shared over `units`; they come off first, then the percentage
 * applies to the remainder. Null when an amount is printed but there is
 * nothing to share it over.
 */
function netUnitPrice(unitPrice: number, units: number | null, disc: LineDiscount): number | null {
	let net = unitPrice;
	const perLine = (disc.amount ?? 0) + (disc.scheme ?? 0);
	if (perLine > 0) {
		if (units === null || units <= 0) return null;
		net -= perLine / units;
	}
	if (disc.pct) net *= 1 - disc.pct / 100;
	return net;
}

function discountTerms(disc: LineDiscount, units: number | null): string[] {
	const u = units !== null ? trimNum(units) : 'qty';
	const terms: string[] = [];
	if (disc.scheme) terms.push(`${trimNum(disc.scheme)} / ${u} scheme`);
	if (disc.amount) terms.push(`${trimNum(disc.amount)} / ${u} disc`);
	if (disc.pct) terms.push(`${trimNum(disc.pct)}%`);
	return terms;
}

/**
 * Client-side mirror of the backend's derive_cost_price().
 *
 * Needed because picking a PLU in the multi-PLU table re-runs the comparison
 * locally against a different catalog row — and uom_qty belongs to the row, so
 * the cost the invoice implies changes with the pick.
 *
 *   net unit price     = invoice price less the line's discount
 *   base cost per unit = net unit price / uom_qty
 *   tax per unit       = line tax / (qty * uom_qty)   (or base * gst%)
 */
function deriveCostPrice(item: ValidatedItem, master: PluOption): DerivedField | null {
	// A cost_price the backend derived belongs to the PLU *it* matched, so it
	// must not block re-derivation against the row the user picked instead —
	// only a figure the invoice actually printed does.
	const backendDerived = item.validation?.derived_fields?.cost_price;
	// A printed cost price with its discount taken off does not depend on the
	// catalog row, so the backend's figure stands for every pick.
	if (backendDerived?.source === 'printed_discount') return backendDerived;
	const printedCost = num(item['cost_price']);
	if (!backendDerived && printedCost !== null) {
		return discountPrintedCost(item, master, printedCost);
	}

	const invUom = normUom(item['uom']);
	const masterUom = normUom(master.uom);
	// Quantities counted in different units cannot be reconciled — an invoice in
	// PCS against a catalog BOX would apply the pack size twice.
	if (invUom && masterUom && invUom !== masterUom) return null;

	const uomQty = num(master.uom_qty) ?? num(item['uom_qty']) ?? 1;
	if (uomQty <= 0) return null;

	const quantity = num(item['quantity']);
	const disc = lineDiscount(item);

	let unitPrice = num(item['invoice_price']);
	const taxable = num(item['taxable_value']);
	let priceStr: string | null = null;
	// A printed taxable value is already net of every discount, so on a
	// discounted line it beats re-deriving the net from the rate.
	if (unitPrice === null || (disc && taxable !== null)) {
		if (taxable === null || quantity === null || quantity <= 0) return null;
		unitPrice = taxable / quantity;
		if (disc) priceStr = `${trimNum(taxable)} / ${trimNum(quantity)}`;
	}
	if (unitPrice <= 0) return null;

	const grossUnitPrice = num(item['invoice_price']) ?? unitPrice;
	if (disc && priceStr === null) {
		const net = netUnitPrice(unitPrice, quantity, disc);
		if (net === null) return null;
		unitPrice = net;
		priceStr = `(${trimNum(grossUnitPrice)} - ${discountTerms(disc, quantity).join(' - ')})`;
	}
	if (priceStr === null) priceStr = trimNum(unitPrice);
	if (unitPrice <= 0) return null;

	const baseUnitCost = unitPrice / uomQty;

	const taxParts = ['sgst_amount', 'cgst_amount', 'igst_amount']
		.map((k) => num(item[k]))
		.filter((n): n is number => n !== null);
	const taxTotal = taxParts.length
		? taxParts.reduce((a, b) => a + b, 0)
		: num(item['gst_amount']);
	const totalUnits = quantity !== null ? quantity * uomQty : null;

	let taxPerUnit: number;
	let source: DerivedField['source'];
	let taxFormula: string;
	if (taxTotal !== null && totalUnits !== null && totalUnits > 0) {
		taxPerUnit = taxTotal / totalUnits;
		source = 'tax_amounts';
		taxFormula = `${trimNum(taxTotal)} / ${trimNum(totalUnits)}`;
	} else {
		const lineRate =
			num(item['gst_percent']) ??
			num(item['tax_pct']) ??
			(() => {
				const halves = ['sgst_pct', 'cgst_pct']
					.map((k) => num(item[k]))
					.filter((n): n is number => n !== null);
				return halves.length ? halves.reduce((a, b) => a + b, 0) : null;
			})();
		// Formats that keep their rates in an HSN summary print neither a tax
		// amount nor a GST% on the line. The catalog row holds the same rate, so
		// it stands in rather than abandoning the derivation — `source` records
		// which of the two was used.
		const rate = lineRate ?? num(master.tax_pct);
		if (rate === null) return null;
		taxPerUnit = (baseUnitCost * rate) / 100;
		source = lineRate === null ? 'catalog_rate' : 'gst_rate';
		taxFormula = `${trimNum(baseUnitCost)} x ${trimNum(rate)}%`;
	}

	// Only the final value is rounded — rounding the base cost first turns
	// 12.4992 into 12.4952, which then reads as a discrepancy.
	const value = Math.round((baseUnitCost + taxPerUnit) * 100) / 100;
	if (value <= 0) return null;

	return {
		value,
		source,
		unit_price: unitPrice,
		...(disc
			? {
					gross_unit_price: grossUnitPrice,
					discount_pct: disc.pct,
					discount_amount: disc.amount,
					scheme_amount: disc.scheme,
					net_unit_price: unitPrice,
				}
			: {}),
		uom: master.uom ?? (item['uom'] as string | null),
		uom_qty: uomQty,
		base_unit_cost: baseUnitCost,
		total_units: totalUnits,
		tax_per_unit: taxPerUnit,
		formula: `${priceStr} / ${trimNum(uomQty)} + ${taxFormula} = ${value.toFixed(2)}`,
	};
}

/**
 * Mirror of the backend's _discount_printed_cost(): a cost price the invoice
 * printed, less the line's discount. The figure is per catalog unit already,
 * so rupee discounts are shared over every unit on the line. Null when the
 * line carries no discount — the printed value then stands as it is.
 */
function discountPrintedCost(
	item: ValidatedItem,
	master: PluOption,
	printed: number,
): DerivedField | null {
	const disc = lineDiscount(item);
	if (!disc || printed <= 0) return null;
	const uomQty = num(master.uom_qty) ?? num(item['uom_qty']) ?? 1;
	const quantity = num(item['quantity']);
	const totalUnits = quantity !== null && uomQty > 0 ? quantity * uomQty : null;
	const net = netUnitPrice(printed, totalUnits, disc);
	if (net === null) return null;
	const value = Math.round(net * 100) / 100;
	if (value <= 0) return null;
	return {
		value,
		source: 'printed_discount',
		unit_price: printed,
		price_source: 'printed cost price',
		gross_unit_price: printed,
		discount_pct: disc.pct,
		discount_amount: disc.amount,
		scheme_amount: disc.scheme,
		net_unit_price: net,
		uom: master.uom ?? (item['uom'] as string | null),
		uom_qty: uomQty,
		quantity,
		total_units: totalUnits,
		formula: `${trimNum(printed)} - ${discountTerms(disc, totalUnits).join(' - ')} = ${value.toFixed(2)}`,
	};
}

/** "10% + scheme 20 + disc 30", for the derived badge. */
function discountSummary(derived: DerivedField): string | null {
	const parts: string[] = [];
	if (derived.discount_pct) parts.push(`${trimNum(derived.discount_pct)}%`);
	if (derived.scheme_amount) parts.push(`scheme ${trimNum(derived.scheme_amount)}`);
	if (derived.discount_amount) parts.push(`disc ${trimNum(derived.discount_amount)}`);
	return parts.length ? parts.join(' + ') : null;
}

function trimNum(val: number): string {
	return String(parseFloat(val.toFixed(4)));
}

/**
 * Marks a value that was computed rather than read off the invoice, and shows
 * the arithmetic behind it. Without this a derived cost price is
 * indistinguishable from one the vendor actually printed.
 */
function DerivedBadge({ derived }: { derived: DerivedField }) {
	const unitLabel = derived.uom ? ` per ${derived.uom}` : '';
	const discount = discountSummary(derived);
	const printedDiscount = derived.source === 'printed_discount';
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className='inline-flex items-center gap-0.5 rounded bg-blue-500/10 px-1 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-400 cursor-help align-middle'>
					<Calculator className='w-2.5 h-2.5' />
					derived
				</span>
			</TooltipTrigger>
			<TooltipContent className='max-w-xs'>
				<p className='font-medium'>
					{printedDiscount
						? "Printed cost price less the line's discount"
						: 'Not printed on the invoice'}
				</p>
				<p className='font-mono text-xs mt-1'>{derived.formula}</p>
				{discount && (
					<p className='text-xs mt-1 opacity-80'>
						{`Discount ${discount} taken off ${trimNum(derived.gross_unit_price ?? derived.unit_price ?? 0)}`}
						{` → ${trimNum(derived.net_unit_price ?? derived.unit_price ?? 0)}${unitLabel}.`}
					</p>
				)}
				{!printedDiscount && (
					<p className='text-xs mt-1 opacity-80'>
						{`${trimNum(derived.unit_price ?? 0)}${unitLabel}`}
						{derived.uom_qty ? ` ÷ ${trimNum(derived.uom_qty)} units` : ''}
						{derived.source === 'tax_amounts'
							? ", plus the line's GST spread over every unit."
							: derived.source === 'catalog_rate'
								? // The invoice printed no rate on this line, so saying
									// "the line's rate" would credit the vendor with a
									// figure that came from the catalog.
									", plus GST at the catalog's rate — the line prints none."
								: ", plus GST at the line's rate."}
					</p>
				)}
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * The three numeric fields a catalog row is compared on.
 *
 * The invoice side and the catalog side spell two of them differently: the
 * backend normalises every OCR header onto `gst_percent`, while `master_items`
 * calls the same number `tax_pct`. Everything keyed off a *discrepancy* — the
 * edits map, accepted-field highlighting, the CSV export, correction hints —
 * uses the invoice-side name, so that is what `field` carries. Mixing the two
 * is what previously made an accepted tax correction vanish from the table.
 */
const COMPARE_FIELDS: Array<{
	field: string;
	masterKey: 'cost_price' | 'mrp' | 'tax_pct';
}> = [
	{ field: 'cost_price', masterKey: 'cost_price' },
	{ field: 'mrp', masterKey: 'mrp' },
	{ field: 'gst_percent', masterKey: 'tax_pct' },
];

// Client-side comparison mirroring backend local_compare logic.
function computeLocalValidation(
	item: ValidatedItem,
	master: PluOption,
): {
	discrepancies: Discrepancy[];
	corrections: Record<string, number | string>;
	derived: DerivedField | null;
} {
	const discrepancies: Discrepancy[] = [];
	const corrections: Record<string, number | string> = {};

	// A cost price the invoice never printed but the pack size implies — so
	// picking a PLU compares against the cost that PLU actually works out to
	// instead of skipping the field.
	const derived = deriveCostPrice(item, master);

	const invoiceField = (field: string): unknown =>
		field === 'gst_percent'
			? (item['gst_percent'] ?? item.tax_pct)
			: field === 'cost_price'
				? // The freshly derived value wins: any cost_price already on the item
					// was derived against a different PLU's pack size.
					(derived?.value ?? item.cost_price)
				: item[field];

	for (const { field, masterKey } of COMPARE_FIELDS) {
		const invVal = parseFloat(String(invoiceField(field) ?? ''));
		const masterVal = parseFloat(String(master[masterKey] ?? ''));
		if (isNaN(invVal) || isNaN(masterVal)) continue;
		if (Math.abs(invVal - masterVal) > 0.01) {
			discrepancies.push({
				field,
				expected: masterVal,
				actual: invVal,
				message: `${fieldLabel(field)} mismatch: invoice has ${invVal}, master has ${masterVal}.`,
			});
			corrections[field] = masterVal;
		}
	}

	const invDescRaw = String(item['sku_description'] ?? item.sku_desc ?? item.product_name ?? '');
	const invDesc = invDescRaw.trim().toUpperCase();
	const masterDesc = String(master.sku_desc ?? '')
		.trim()
		.toUpperCase();
	if (invDesc && masterDesc && invDesc !== masterDesc) {
		discrepancies.push({
			field: 'sku_description',
			expected: master.sku_desc,
			actual: invDescRaw,
			message: `Product description mismatch: invoice has '${invDescRaw}', master has '${master.sku_desc}'.`,
		});
		corrections['sku_description'] = master.sku_desc ?? '';
	}

	return { discrepancies, corrections, derived };
}

interface PluSelection {
	plu_code: string;
	discrepancies: Discrepancy[];
	corrections: Record<string, number | string>;
	/** Cost price this PLU's pack size implies, when the invoice printed none. */
	derived: DerivedField | null;
}

/** Middle columns a candidate table can carry, between PLU/name and the
 *  differences summary. */
type OptionColumn = 'ean' | 'cost_price' | 'mrp' | 'tax_pct' | 'priority';

const OPTION_COLUMNS: Record<
	OptionColumn,
	{
		header: string;
		value: (opt: PluOption) => string | number | null | undefined;
		/** Discrepancy field this column tracks, when a mismatch should colour it. */
		compare?: string;
		/** Value for the invoice reference row; a column without one sits empty. */
		invoice?: (item: ValidatedItem) => string;
		mono?: boolean;
	}
> = {
	ean: {
		header: 'EAN',
		value: (opt) => opt.ean_code,
		invoice: (item) => String(item.ean_code ?? '—'),
		mono: true,
	},
	cost_price: {
		header: 'Cost Price',
		value: (opt) => opt.cost_price,
		compare: 'cost_price',
		invoice: (item) => String(item.cost_price ?? '—'),
		mono: true,
	},
	mrp: {
		header: 'MRP',
		value: (opt) => opt.mrp,
		compare: 'mrp',
		invoice: (item) => String(item.mrp ?? '—'),
		mono: true,
	},
	tax_pct: {
		header: 'Tax %',
		value: (opt) => opt.tax_pct,
		compare: 'gst_percent',
		invoice: (item) => String(item['gst_percent'] ?? item.tax_pct ?? '—'),
		mono: true,
	},
	priority: {
		header: 'Priority',
		value: (opt) => opt.priority,
	},
};

const DEFAULT_OPTION_COLUMNS: OptionColumn[] = ['ean', 'cost_price', 'mrp', 'tax_pct'];

// The one candidate table behind every place a catalog record gets picked: the
// multi-PLU chooser, the runners-up behind a fuzzy or auto-selected match, and
// the records considered for an item that matched nothing. They differ only in
// which middle columns they carry and whether the invoice values head the
// table, so those are props rather than three copies of the markup.
function MatchOptionsTable({
	item,
	options,
	additionalOptions,
	columns = DEFAULT_OPTION_COLUMNS,
	showInvoiceRow = true,
	recommendedPlu,
	activePlu,
	onSelect,
}: {
	item: ValidatedItem;
	options: PluOption[];
	/** Candidates ranked below `options`, hidden behind the footer toggle. */
	additionalOptions?: PluOption[];
	columns?: OptionColumn[];
	showInvoiceRow?: boolean;
	recommendedPlu?: string | null;
	activePlu?: string | null;
	/** `fromAdditional` says the pick came from the revealed tail — the signal
	 *  that tells us the ranking put the right record too low. */
	onSelect: (opt: PluOption, fromAdditional: boolean) => void;
}) {
	const cols = columns.map((key) => ({ key, ...OPTION_COLUMNS[key] }));
	const [showAll, setShowAll] = useState(false);
	// Kept out of the way by default rather than dropped: a twenty-row table
	// buries the recommendation it is supposed to support, and the answer is
	// usually in the first few. When it is not, these rows have already been
	// fetched and ranked server-side, so reaching them costs nothing — which is
	// the difference between the user picking the right record and re-uploading
	// the invoice.
	const extra = additionalOptions ?? [];
	const shown = showAll ? [...options, ...extra] : options;
	// PLU code, product name, the middle columns, differences, the action cell.
	const colSpan = cols.length + 4;
	return (
		<Table>
			<TableHeader>
				<UITableRow className='bg-muted/50 hover:bg-muted/50'>
					<TableHead className='text-xs font-semibold text-foreground'>
						PLU Code
					</TableHead>
					<TableHead className='text-xs font-semibold text-foreground'>
						Product Name
					</TableHead>
					{cols.map((col) => (
						<TableHead key={col.key} className='text-xs font-semibold text-foreground'>
							{col.header}
						</TableHead>
					))}
					<TableHead className='text-xs font-semibold text-foreground'>
						Differences
					</TableHead>
					<TableHead className='w-24' />
				</UITableRow>
				{/* Invoice reference row */}
				{showInvoiceRow && (
					<UITableRow className='bg-blue-50/60 dark:bg-blue-950/20 hover:bg-blue-50/60'>
						<TableCell className='text-xs text-blue-600 dark:text-blue-400 font-semibold py-1.5 italic'>
							Invoice
						</TableCell>
						<TableCell className='text-xs font-mono py-1.5 text-blue-700 dark:text-blue-300'>
							{String(
								item['sku_description'] ??
									item.sku_desc ??
									item.product_name ??
									'—',
							)}
						</TableCell>
						{cols.map((col) => (
							<TableCell
								key={col.key}
								className='text-xs font-mono py-1.5 text-blue-700 dark:text-blue-300'>
								{col.invoice?.(item)}
							</TableCell>
						))}
						<TableCell className='py-1.5' />
						<TableCell className='py-1.5' />
					</UITableRow>
				)}
			</TableHeader>
			<TableBody>
				{shown.map((opt, i) => {
					const fromAdditional = i >= options.length;
					const { discrepancies: optDiffs } = computeLocalValidation(item, opt);
					const diffFields = new Set(optDiffs.map((d) => d.field));
					// A column with nothing to compare against stays neutral — only the
					// fields a discrepancy can name are coloured.
					const cellCls = (field?: string) =>
						!field
							? ''
							: diffFields.has(field)
								? 'text-destructive font-semibold'
								: 'text-green-700 dark:text-green-400';
					const isRecommended = opt.plu_code === recommendedPlu;
					const isActive = opt.plu_code === activePlu;
					const rowBg = isActive
						? 'bg-violet-50 dark:bg-violet-950/30 hover:bg-violet-50'
						: isRecommended
							? 'bg-amber-50/70 dark:bg-amber-950/20 hover:bg-amber-50/70'
							: 'hover:bg-muted/30';
					// Marks where the shortlist ended, so expanding does not silently
					// rewrite what the recommendation was.
					const startsTail = fromAdditional && i === options.length;
					return (
						<UITableRow
							key={opt.plu_code}
							className={`${rowBg}${startsTail ? ' border-t-2 border-t-border' : ''}`}>
							<TableCell className='text-sm font-mono py-2 whitespace-nowrap'>
								<span className='flex items-center gap-1.5'>
									{opt.plu_code}
									{isRecommended && (
										<Badge
											variant='outline'
											className='text-amber-700 dark:text-amber-400 border-amber-300 bg-amber-50 dark:bg-amber-950/20 text-[10px] px-1.5 py-0 gap-0.5'>
											<Sparkles className='w-2.5 h-2.5' />
											Recommended
										</Badge>
									)}
								</span>
							</TableCell>
							<TableCell className={`text-sm py-2 ${cellCls('sku_description')}`}>
								{opt.sku_desc ?? '—'}
							</TableCell>
							{cols.map((col) => (
								<TableCell
									key={col.key}
									className={`text-sm py-2 ${col.mono ? 'font-mono ' : ''}${cellCls(col.compare)}`}>
									{col.value(opt) ?? '—'}
								</TableCell>
							))}
							<TableCell className='py-2'>
								{optDiffs.length === 0 ? (
									<span className='flex items-center gap-1 text-xs text-green-600 dark:text-green-400'>
										<CheckCircle2 className='w-3.5 h-3.5' />
										No issues
									</span>
								) : (
									<span className='flex flex-wrap gap-1'>
										{optDiffs.map((d) => (
											<Badge
												key={d.field}
												variant='outline'
												className='text-destructive border-destructive/30 bg-destructive/5 text-xs px-1.5 py-0'>
												{fieldLabel(d.field)}
											</Badge>
										))}
									</span>
								)}
							</TableCell>
							<TableCell className='py-2' onClick={(e) => e.stopPropagation()}>
								{isActive ? (
									<span className='flex items-center gap-1 text-xs font-medium text-violet-700 dark:text-violet-400'>
										<CheckCircle2 className='w-3.5 h-3.5' />
										Selected
									</span>
								) : (
									<Button
										variant='outline'
										size='sm'
										className='h-7 text-xs'
										onClick={() => onSelect(opt, fromAdditional)}>
										Select
									</Button>
								)}
							</TableCell>
						</UITableRow>
					);
				})}
			</TableBody>
			{extra.length > 0 && (
				<tfoot>
					<UITableRow className='hover:bg-transparent border-t border-border'>
						<TableCell colSpan={colSpan} className='py-1.5'>
							<Button
								variant='ghost'
								size='sm'
								className='h-7 gap-1 text-xs text-muted-foreground hover:text-foreground'
								onClick={(e) => {
									e.stopPropagation();
									setShowAll((s) => !s);
								}}>
								{showAll ? (
									<>
										<ChevronDown className='w-3.5 h-3.5 rotate-180' />
										Show top {options.length} only
									</>
								) : (
									<>
										<ChevronDown className='w-3.5 h-3.5' />
										Show all {options.length + extra.length} considered
									</>
								)}
							</Button>
						</TableCell>
					</UITableRow>
				</tfoot>
			)}
		</Table>
	);
}

// ---------------------------------------------------------------------------
// Calculation validation — field-name candidates. Every consumer matches
// through normKey(), which lowercases and strips non-alphanumerics, so each
// entry is stored in that form already: adding a "base_rate" beside "baserate"
// buys nothing, both collapse to the same key.
// ---------------------------------------------------------------------------

const TAX_AMOUNT_CANDIDATES = ['taxamount', 'taxamt', 'gstamount', 'vatamount'];
const LINE_AMOUNT_CANDIDATES = [
	'amount',
	'netamount',
	'linetotal',
	'totalamount',
	'value',
	'netvalue',
	'lineamount',
];
// Ordered most-specific first — findGrandTotal walks this list in order and
// takes the first candidate present, so an unambiguous "grand_total" always
// beats a generic "total" that may well be a page subtotal.
const GRAND_TOTAL_CANDIDATES = [
	'grandtotal',
	'grandtotalamount',
	'invoicegrandtotal',
	'invoicetotal',
	'totalinvoicevalue',
	'totalinvoiceamount',
	'invoicevalue',
	'invoiceamount',
	'totalamountpayable',
	'netamountpayable',
	'amountpayable',
	'netpayable',
	'payableamount',
	'totalpayable',
	'amountdue',
	'totaldue',
	'billamount',
	'totalbillamount',
	'nettotal',
	'grosstotal',
	'roundedtotal',
	'finalamount',
	'finaltotal',
	'totalamount',
	'totalnetamount',
	'netamount',
	'nettaxableamount',
	'totalvalue',
	'total',
];

// Per-unit price as printed on the line. This is per invoice UOM — per pack —
// not per catalog unit, which is why it can never be compared against a cost
// price without applying the pack size first.
const UNIT_PRICE_CANDIDATES = [
	'invoiceprice',
	'rate',
	'unitprice',
	'baserate',
	'brate',
	'basicrate',
];
// Pre-tax line value. Only unambiguous names live here; a bare "total" is
// admitted separately and only when the line's structure proves it is pre-tax.
const TAXABLE_VALUE_CANDIDATES = ['taxablevalue', 'taxableamount', 'assessablevalue'];
const AMBIGUOUS_TAXABLE_CANDIDATES = ['total', 'subtotal', 'grossamount'];
// GST components are whole-line figures by invoice convention, never per unit.
// Amount-suffixed names are tried first so a bare "cgst" holding a percentage
// is never summed alongside a real "cgst_amount".
const GST_SPLIT_AMOUNT_CANDIDATES = [
	'cgstamount',
	'cgstamt',
	'sgstamount',
	'sgstamt',
	'igstamount',
	'igstamt',
	'utgstamount',
	'cessamount',
];
const GST_SPLIT_BARE_CANDIDATES = ['cgst', 'sgst', 'igst', 'utgst', 'cess'];
const TAX_PCT_CANDIDATES = ['taxpct', 'taxpercent', 'gstpercent', 'gstpct', 'gstrate', 'taxrate'];

const CURRENCY_NOISE_RE =
	/[\u20b9$\u20ac\u00a3\u00a5]|\b(?:inr|rs|usd|eur|gbp|aed|rupees?|only)\b\.?|\/-/gi;

function parseAmount(v: unknown): number {
	if (typeof v === 'number') return v;
	const raw = String(v ?? '');
	if (!raw.trim()) return NaN;
	let s = raw.replace(CURRENCY_NOISE_RE, '').replace(/[,\s]/g, '');
	// Accounting negatives: (1,200.04) means −1200.04.
	let sign = 1;
	const paren = s.match(/^\((.*)\)$/);
	if (paren) {
		sign = -1;
		s = paren[1];
	}
	if (!/^[+-]?\d*\.?\d+$/.test(s)) return NaN;
	const n = parseFloat(s);
	return isNaN(n) ? NaN : sign * n;
}

function normKey(k: string): string {
	return k.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Drops a trailing currency/unit token from an already-normalised key, so
// "totalamountinr" can still match the "totalamount" candidate. Applied only
// when matching grand totals, and only as a fallback.
const CURRENCY_SUFFIX_RE = /(inr|inrs|rs|rupees|usd|eur|gbp)$/;

function stripCurrencySuffix(norm: string): string {
	const stripped = norm.replace(CURRENCY_SUFFIX_RE, '');
	// Guard against eating a whole short key (e.g. "rs" on its own).
	return stripped.length >= 4 ? stripped : norm;
}

// Find a field in an item by any of the candidate keys; returns [key, numericValue].
function findFieldValue(
	item: Record<string, unknown>,
	candidates: string[],
): { key: string; value: number } | null {
	const normCandidates = new Set(candidates.map(normKey));
	for (const [k, v] of Object.entries(item)) {
		if (k === 'validation') continue;
		if (normCandidates.has(normKey(k))) {
			const n = parseAmount(v);
			if (!isNaN(n)) return { key: k, value: n };
		}
	}
	return null;
}

interface ScalarHit {
	key: string;
	value: number;
}

// Every numeric document-level scalar, indexed by normalised key. Currency and
// unit suffixes ride along on plenty of OCR'd headers — "Total Amount (INR)",
// "grand_total_rs" — so the stripped form is registered as an alias, but only
// after every exact name is in, so a key that matches on its own is never
// displaced by another key's alias. `excludeKey` keeps the field already taken
// as the grand total from being read a second time as a summary figure.
function indexScalars(
	scalars: Record<string, unknown>,
	excludeKey: string | null = null,
): Map<string, ScalarHit> {
	const byNorm = new Map<string, ScalarHit>();
	const numeric: Array<{ key: string; norm: string; value: number }> = [];
	for (const [k, v] of Object.entries(scalars)) {
		if (k === excludeKey) continue;
		const n = parseAmount(v);
		if (isNaN(n)) continue;
		const norm = normKey(k);
		numeric.push({ key: k, norm, value: n });
		// first occurrence of a name wins
		if (!byNorm.has(norm)) byNorm.set(norm, { key: k, value: n });
	}
	for (const { key, norm, value } of numeric) {
		const denoised = stripCurrencySuffix(norm);
		if (denoised !== norm && !byNorm.has(denoised)) {
			byNorm.set(denoised, { key, value });
		}
	}
	return byNorm;
}

// First candidate present, in candidate order — so the most specific name
// wins rather than whichever key the document happens to list first.
function pickOrdered(index: Map<string, ScalarHit>, candidates: string[]): ScalarHit | null {
	for (const candidate of candidates) {
		const hit = index.get(normKey(candidate));
		if (hit) return hit;
	}
	return null;
}

// Find a grand-total field in the document-level scalar map. Candidates are
// tried in priority order rather than taking whichever key the document
// happens to list first, so the most specific name present always wins.
function findGrandTotal(scalars: Record<string, unknown>): { key: string; value: number } | null {
	return pickOrdered(indexScalars(scalars), GRAND_TOTAL_CANDIDATES);
}

// ---------------------------------------------------------------------------
// Invoice summary figures — what sits between the computed line subtotal and
// the grand total: document-level charges, discount, tax and round-off
// printed in the summary block. Each family below yields at most one figure,
// most specific spelling first, so "freight" and "freight_charges" on the
// same document are never both added.
// ---------------------------------------------------------------------------

const SUMMARY_CHARGE_FAMILIES: Array<{ label: string; candidates: string[] }> = [
	{
		label: 'Freight',
		candidates: ['freightcharges', 'freightcharge', 'freightamount', 'freight'],
	},
	{
		label: 'Shipping / delivery',
		candidates: [
			'shippingcharges',
			'shippingcharge',
			'shipping',
			'deliverycharges',
			'deliverycharge',
			'transportcharges',
			'transportationcharges',
			'cartage',
		],
	},
	{
		label: 'Packing / forwarding',
		candidates: [
			'packingandforwarding',
			'packingforwarding',
			'forwardingcharges',
			'packingcharges',
			'packingcharge',
			'packing',
		],
	},
	{ label: 'Insurance', candidates: ['insurancecharges', 'insurance'] },
	{
		label: 'Handling',
		candidates: ['handlingcharges', 'handlingcharge', 'loadingcharges', 'unloadingcharges'],
	},
	{
		label: 'Other charges',
		candidates: [
			'othercharges',
			'othercharge',
			'misccharges',
			'miscellaneouscharges',
			'additionalcharges',
			'extracharges',
			'servicecharges',
			'servicecharge',
		],
	},
	{ label: 'TCS', candidates: ['tcsamount', 'tcs'] },
];

// A total-discount figure already covers every kind, so when one is printed
// the individual families are not read on top of it.
const SUMMARY_TOTAL_DISCOUNT_CANDIDATES = [
	'totaldiscount',
	'totaldiscountamount',
	'invoicediscount',
	'billdiscount',
];
const SUMMARY_DISCOUNT_FAMILIES: Array<{ label: string; candidates: string[] }> = [
	{
		label: 'Discount',
		candidates: ['discountamount', 'discountamt', 'discount', 'lessdiscount'],
	},
	{
		label: 'Cash / trade discount',
		candidates: [
			'cashdiscountamount',
			'cashdiscount',
			'tradediscount',
			'specialdiscount',
			'additionaldiscount',
		],
	},
	{
		label: 'Scheme',
		candidates: ['schemediscount', 'schemeamount', 'scheme'],
	},
];
const SUMMARY_ROUND_OFF_CANDIDATES = [
	'roundoffamount',
	'roundoffadjustment',
	'roundingadjustment',
	'roundoffvalue',
	'roundoffdifference',
	'roundingamount',
	'roundoff',
	'roundedoff',
	'roundingoff',
	'rounding',
];
// One figure that already totals the tax, tried before the components so a
// document printing both is never counted twice.
const SUMMARY_TAX_TOTAL_CANDIDATES = [
	'totaltaxamount',
	'totaltax',
	'taxtotal',
	'totalgstamount',
	'totalgst',
	'gsttotal',
	'gstamount',
	'taxamount',
];
const SUMMARY_TAX_SPLIT_CANDIDATES = [
	'cgsttotal',
	'sgsttotal',
	'igsttotal',
	'totalcgst',
	'totalsgst',
	'totaligst',
	'cgstamount',
	'sgstamount',
	'igstamount',
	'utgstamount',
	'cessamount',
];
// Bare GST names at document level are the summary amounts on most invoices,
// but they are tried only when no amount-suffixed key exists, as at line level.
const SUMMARY_TAX_BARE_CANDIDATES = ['cgst', 'sgst', 'igst', 'utgst', 'cess'];
const SUMMARY_SUBTOTAL_CANDIDATES = [
	'subtotal',
	'subtotalamount',
	'totaltaxablevalue',
	'totaltaxableamount',
	'taxablevalue',
	'taxableamount',
	'totalbeforetax',
	'amountbeforetax',
	'totalbasicamount',
	'basicamount',
	'basicvalue',
	'totalbasic',
];

interface SummaryFigures {
	charges: Array<ScalarHit & { label: string }>;
	discounts: Array<ScalarHit & { label: string }>;
	roundOff: ScalarHit | null;
	taxTotal: { keys: string[]; value: number } | null;
	/** The invoice's own printed "Subtotal" line, kept only as a cross-check —
	 *  the reconciliation is built from the computed line subtotal instead,
	 *  since many invoices never print this field at all. */
	printedSubtotal: ScalarHit | null;
}

function sumHits(
	index: Map<string, ScalarHit>,
	candidates: string[],
): { keys: string[]; value: number } | null {
	const keys: string[] = [];
	let total = 0;
	for (const c of candidates) {
		const hit = index.get(normKey(c));
		if (!hit || keys.includes(hit.key)) continue;
		keys.push(hit.key);
		total += hit.value;
	}
	return keys.length ? { keys, value: parseFloat(total.toFixed(4)) } : null;
}

function findSummaryFigures(
	scalars: Record<string, unknown>,
	grandTotalKey: string | null,
): SummaryFigures {
	const index = indexScalars(scalars, grandTotalKey);
	const charges: SummaryFigures['charges'] = [];
	for (const fam of SUMMARY_CHARGE_FAMILIES) {
		const hit = pickOrdered(index, fam.candidates);
		if (hit && hit.value !== 0) charges.push({ ...hit, label: fam.label });
	}
	const discounts: SummaryFigures['discounts'] = [];
	const totalDiscount = pickOrdered(index, SUMMARY_TOTAL_DISCOUNT_CANDIDATES);
	if (totalDiscount) {
		if (totalDiscount.value !== 0)
			discounts.push({ ...totalDiscount, label: 'Total discount' });
	} else {
		for (const fam of SUMMARY_DISCOUNT_FAMILIES) {
			const hit = pickOrdered(index, fam.candidates);
			if (hit && hit.value !== 0) discounts.push({ ...hit, label: fam.label });
		}
	}
	const taxSingle = pickOrdered(index, SUMMARY_TAX_TOTAL_CANDIDATES);
	const taxTotal = taxSingle
		? { keys: [taxSingle.key], value: taxSingle.value }
		: (sumHits(index, SUMMARY_TAX_SPLIT_CANDIDATES) ??
			sumHits(index, SUMMARY_TAX_BARE_CANDIDATES));
	return {
		charges,
		discounts,
		roundOff: pickOrdered(index, SUMMARY_ROUND_OFF_CANDIDATES),
		taxTotal,
		printedSubtotal: pickOrdered(index, SUMMARY_SUBTOTAL_CANDIDATES),
	};
}

// ---------------------------------------------------------------------------
// Grand-total reconciliation
// ---------------------------------------------------------------------------

const GRAND_TOTAL_TOLERANCE = 0.05;

/** One rung of the ladder from the validated product total to the invoice total. */
interface ReconciliationStep {
	label: string;
	/** Field(s) the figure was read from; empty for a computed rung. */
	fields: string[];
	/** Signed contribution to the expected grand total. */
	amount: number;
	note?: string;
}

/** A summary discount, or the part of one, the line cost prices already carry. */
interface CoveredDiscount {
	label: string;
	key: string;
	value: number;
	covered: number;
}

interface Reconciliation {
	steps: ReconciliationStep[];
	expected: number;
	ok: boolean;
	coveredDiscounts: CoveredDiscount[];
}

/**
 * Builds the ladder: the computed line subtotal, plus summary charges, less
 * summary discount, plus the invoice's tax, plus round-off — and compares it
 * with the invoice's printed grand total.
 *
 * Subtotal + Tax = Grand Total is the whole rule; nothing here is inferred
 * or tried as a fallback variant, so a mismatch always means the figures
 * genuinely disagree rather than a guess that happened not to land.
 *
 * The tax rung is read from the invoice summary where one is printed, and
 * otherwise (`lineTaxTotal`) summed from the lines, which is where plenty of
 * invoices print their only tax figures. That is not a guess — it is the same
 * printed tax read from a different part of the page — and without it a
 * document that reconciles perfectly is reported as a mismatch by exactly its
 * own tax.
 *
 * The computed subtotal is already net of every discount applied line by
 * line (each line's own scheme/amount/percentage, taken off before its tax).
 * An invoice that prints that same discount again as one summary figure must
 * not have it taken off twice, so `subtotalDiscountApplied` (the rupee
 * discount already inside the computed subtotal) is set against the summary
 * discounts first; only what the lines did not already carry comes off as a
 * rung.
 */
function reconcileGrandTotal(
	computedSubtotal: number,
	linesIncluded: number,
	summary: SummaryFigures,
	documentTotal: number | null,
	subtotalDiscountApplied = 0,
	lineTaxTotal: number | null = null,
): Reconciliation {
	const steps: ReconciliationStep[] = [
		{
			label: 'Subtotal',
			fields: [],
			amount: computedSubtotal,
			note: `taxable value summed over ${linesIncluded} line${linesIncluded === 1 ? '' : 's'}`,
		},
	];
	for (const c of summary.charges)
		steps.push({ label: c.label, fields: [c.key], amount: c.value });

	const coveredDiscounts: CoveredDiscount[] = [];
	let pool = Math.max(0, subtotalDiscountApplied);
	for (const d of summary.discounts) {
		const covered = Math.min(d.value, pool);
		pool -= covered;
		const remainder = parseFloat((d.value - covered).toFixed(2));
		if (covered > 0)
			coveredDiscounts.push({ label: d.label, key: d.key, value: d.value, covered });
		if (remainder <= GRAND_TOTAL_TOLERANCE) continue;
		steps.push({
			label: d.label,
			fields: [d.key],
			amount: -remainder,
			note:
				covered > 0
					? `${covered.toFixed(2)} of ${d.value.toFixed(2)} already reflected in the line taxable values`
					: undefined,
		});
	}

	if (summary.taxTotal) {
		steps.push({
			label: 'Total tax',
			fields: summary.taxTotal.keys,
			amount: summary.taxTotal.value,
		});
	} else if (lineTaxTotal !== null) {
		steps.push({
			label: 'Total tax',
			fields: [],
			amount: lineTaxTotal,
			note: 'summed from the line items; the invoice summary prints no tax total',
		});
	}

	if (summary.roundOff) {
		steps.push({
			label: 'Round off',
			fields: [summary.roundOff.key],
			amount: summary.roundOff.value,
		});
	}

	const expected = parseFloat(steps.reduce((acc, st) => acc + st.amount, 0).toFixed(2));
	const ok =
		documentTotal !== null && Math.abs(expected - documentTotal) <= GRAND_TOTAL_TOLERANCE;
	return { steps, expected, ok, coveredDiscounts };
}

// findFieldValue returns whichever key the item happens to list first. Where
// several candidates could match one slot, priority has to come from the
// candidate list instead, so an explicit "taxable_value" always beats a
// generic "total".
function findFieldOrdered(
	item: Record<string, unknown>,
	candidates: string[],
): { key: string; value: number } | null {
	const byNorm = new Map<string, { key: string; value: number }>();
	for (const [k, v] of Object.entries(item)) {
		if (k === 'validation') continue;
		const n = parseAmount(v);
		if (isNaN(n)) continue;
		const nk = normKey(k);
		if (!byNorm.has(nk)) byNorm.set(nk, { key: k, value: n });
	}
	for (const c of candidates) {
		const hit = byNorm.get(normKey(c));
		if (hit) return hit;
	}
	return null;
}

// Adds up every matching column — a GST total is split across CGST and SGST,
// so no single field holds it.
function sumFields(
	item: Record<string, unknown>,
	candidates: string[],
): { keys: string[]; value: number } | null {
	const norm = new Set(candidates.map(normKey));
	const keys: string[] = [];
	let total = 0;
	for (const [k, v] of Object.entries(item)) {
		if (k === 'validation') continue;
		if (!norm.has(normKey(k))) continue;
		const n = parseAmount(v);
		if (isNaN(n)) continue;
		keys.push(k);
		total += n;
	}
	return keys.length ? { keys, value: parseFloat(total.toFixed(4)) } : null;
}

/** Standard Indian GST slabs, for recognising a tax-inclusive column when the
 *  invoice states no rate anywhere the line can see. */
const GST_SLABS = [5, 12, 18, 28];

/**
 * Whether this invoice's line-amount column is printed before or after tax.
 *
 * A line on its own cannot tell: 1,150.00 is a plausible pre-tax total and a
 * plausible tax-inclusive one, and reporting an arithmetic error against the
 * wrong basis states the wrong expected figure. The rest of the invoice can
 * tell, though — the lines that *do* reconcile all reconcile on the same
 * basis, because one vendor's template prints one of them. So the basis is
 * decided by vote across every line and applied to the one that fails.
 *
 * Deliberately reads only what the invoice printed — rate, quantity, discount,
 * tax rate, amount — so it does not depend on a catalog match and gives the
 * same answer for a matched and an unmatched line.
 */
function lineAmountBasis(items: ValidatedItem[]): 'pre_tax' | 'tax_inclusive' | 'unknown' {
	let preTaxHits = 0;
	let inclusiveHits = 0;
	for (const raw of items) {
		const item = raw as Record<string, unknown>;
		const amountField = findFieldValue(item, LINE_AMOUNT_CANDIDATES);
		const unitPrice = findFieldOrdered(item, UNIT_PRICE_CANDIDATES);
		const quantity = num(item['quantity']);
		if (!amountField || !unitPrice || quantity === null) continue;
		const amount = amountField.value;

		const disc = lineDiscount(item);
		const gross = round2(unitPrice.value * quantity);
		const net = disc ? netUnitPrice(gross, 1, disc) : gross;
		if (net === null) continue;

		if (Math.abs(round2(net) - amount) <= 0.05) {
			preTaxHits += 1;
			continue;
		}
		const rate = findFieldOrdered(item, TAX_PCT_CANDIDATES)?.value;
		if (rate === undefined) continue;
		if (Math.abs(round2(net * (1 + rate / 100)) - amount) <= 0.05) inclusiveHits += 1;
	}
	if (preTaxHits > inclusiveHits) return 'pre_tax';
	if (inclusiveHits > preTaxHits) return 'tax_inclusive';
	return 'unknown';
}

interface CalcCheck {
	label: string;
	field: string;
	formula: string;
	calculated: number;
	actual: number;
	ok: boolean;
	/** False when the correct value cannot be written back to one column — a GST
	 *  total split across CGST/SGST has no single field to accept it into. */
	acceptable?: boolean;
}

interface LineCalcResult {
	idx: number;
	checks: CalcCheck[];
}

/** One line item's contribution to the computed subtotal. */
interface SubtotalLineContribution {
	idx: number;
	name: string;
	/** Taxable value this line contributed; null when it could not be
	 *  established at all (no tax fields and no line amount). */
	taxable: number | null;
	/** How the taxable value was established, most reliable first. */
	taxableSource: 'printed' | 'computed' | 'back_out' | 'line_amount' | 'none';
	tax: number | null;
	lineAmount: number | null;
}

interface CalcValidationResult {
	lineResults: LineCalcResult[];
	lineAmountSum: number;
	grandTotalCheck: {
		/** null when the document has no recognisable invoice-total field. */
		field: string | null;
		documentTotal: number | null;
		/** Whether Subtotal + Tax (+ any summary charges/discount/round-off)
		 *  meets the invoice total. */
		ok: boolean;
		/** Whether the printed line amounts alone meet it — a cross-check. */
		lineSumOk: boolean;
		/** Lines that contributed an amount to lineAmountSum. */
		linesCounted: number;
		/** Total lines on the invoice. */
		linesTotal: number;
		/** True when some line had no recognisable amount column, so the sum is
		 *  known to be short and a mismatch is not necessarily a real discrepancy. */
		partial: boolean;
		/** Σ taxable value over every line, each on its own tax rate. */
		subtotal: number;
		/** Lines that contributed a taxable value to `subtotal`. */
		subtotalLinesIncluded: number;
		/** True when some line's taxable value could not be established at all. */
		subtotalPartial: boolean;
		contributions: SubtotalLineContribution[];
		/** The ladder from the computed subtotal to the invoice total. */
		steps: ReconciliationStep[];
		expectedTotal: number;
		/** Rupee discount already netted out of `subtotal` line by line. */
		subtotalDiscountApplied: number;
		/** Summary discounts, or parts of them, not taken off again for that reason. */
		coveredDiscounts: CoveredDiscount[];
		/** The invoice's own printed "Subtotal" field, shown as a cross-check. */
		printedSubtotal: ScalarHit | null;
		/** Tax total read from the invoice summary. */
		taxTotal: { keys: string[]; value: number } | null;
	} | null;
}

// ---------------------------------------------------------------------------

// Maps a discrepancy field to a stable flag_type string for the profiles API.
function getDiscrepancyFlagType(field: string): string {
	return `${field}_discrepancy`;
}

// Returns an item-level flag_type for investigation records.
function getItemFlagType(matchType?: string): string {
	if (matchType === 'no_match') return 'no_match';
	if (matchType === 'fuzzy_name') return 'fuzzy_match';
	if (matchType === 'multi_plu') return 'multi_plu';
	return 'field_discrepancy';
}

interface Props {
	items: ValidatedItem[];
	documentScalars?: Record<string, unknown>;
	sourceFilename?: string;
}

const ValidationResults = ({ items, documentScalars, sourceFilename }: Props) => {
	const track = useBehaviorTracker({ sourceFilename });
	const [expanded, setExpanded] = useState<Set<number>>(new Set());
	const [edits, setEdits] = useState<Record<number, Record<string, string>>>({});
	const [pluSelections, setPluSelections] = useState<Record<number, PluSelection>>({});
	const [acceptedFields, setAcceptedFields] = useState<Record<number, Set<string>>>({});
	const [editingDiscrepancy, setEditingDiscrepancy] = useState<Record<number, Set<string>>>({});
	// Rows whose full-field editor is open. Every row can be edited, not just
	// unmatched ones — a clean match can still carry a mis-read value.
	const [editingRow, setEditingRow] = useState<Set<number>>(new Set());
	// Row-by-row breakdown under the Grand Total panel.
	const [showTotalBreakdown, setShowTotalBreakdown] = useState(false);
	// Phase 2: dismissals and investigation outcomes
	const [dismissedFields, setDismissedFields] = useState<Record<number, Set<string>>>({});
	const [itemOutcomes, setItemOutcomes] = useState<Record<number, string>>({});
	// Phase 2: flags suppressed by the backend (low_signal_flags from user_profiles)
	const [suppressedFlags, setSuppressedFlags] = useState<Set<string>>(new Set());
	// PLU auto-select preference
	const [autoSelectPlu, setAutoSelectPlu] = useState(false);
	// Feedback flash: itemIdx → last clicked feedback type, auto-clears after 1.5s
	const [feedbackFlash, setFeedbackFlash] = useState<Record<number, string>>({});
	// Tracks which (itemIdx:flagType) combos have had flag-exposure fired this session.
	const exposedRef = useRef<Set<string>>(new Set());
	// hint map: key is `${plu_code}:${field}` or `${ean_code}:${field}`
	const [hintMap, setHintMap] = useState<Map<string, FieldHint>>(new Map());
	// Ref for the copy event listener (copied_summary signal)
	const containerRef = useRef<HTMLDivElement>(null);
	// Data-row elements by index, so the Grand Total panel can jump straight to
	// the line it says is causing a shortfall instead of leaving the user to
	// scroll and hunt for it.
	const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());

	// Fire flag-exposure for discrepancies/match-types as rows are expanded.
	useEffect(() => {
		for (const idx of expanded) {
			const v = items[idx]?.validation;
			if (!v) continue;
			// Field-level discrepancies
			for (const d of v.discrepancies) {
				const key = `${idx}:${getDiscrepancyFlagType(d.field)}`;
				if (!exposedRef.current.has(key)) {
					exposedRef.current.add(key);
					recordFlagExposure(getDiscrepancyFlagType(d.field));
				}
			}
			// Match-type flags
			if (
				v.match_type === 'no_match' ||
				v.match_type === 'fuzzy_name' ||
				v.match_type === 'multi_plu'
			) {
				const flagType = getItemFlagType(v.match_type);
				const key = `${idx}:${flagType}`;
				if (!exposedRef.current.has(key)) {
					exposedRef.current.add(key);
					recordFlagExposure(flagType);
				}
			}
		}
	}, [expanded, items]);

	// Fetch user profile on mount → populate suppressedFlags + autoSelectPlu.
	useEffect(() => {
		getUserProfile().then((profile) => {
			if (profile?.low_signal_flags?.length) {
				setSuppressedFlags(new Set(profile.low_signal_flags));
			}
			if (profile?.auto_select_plu) {
				setAutoSelectPlu(true);
			}
		});
	}, []);

	// copied_summary — fires whenever the user copies text from within the validation UI.
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const handler = () => track('copied_summary');
		el.addEventListener('copy', handler);
		return () => el.removeEventListener('copy', handler);
	}, [track]);

	// Fetch field correction hints for all matched PLUs/EANs once items arrive.
	useEffect(() => {
		const pluCodes = items
			.map((item) => item.validation?.matched_plu)
			.filter((p): p is string => Boolean(p));
		const eanCodes = items.map((item) => item.ean_code).filter((e): e is string => Boolean(e));
		if (!pluCodes.length && !eanCodes.length) return;
		getFieldHints(pluCodes, eanCodes).then((hints) => {
			const map = new Map<string, FieldHint>();
			for (const h of hints) {
				const key = h.plu_code ? `${h.plu_code}:${h.field}` : `${h.ean_code}:${h.field}`;
				map.set(key, h);
			}
			setHintMap(map);
		});
	}, [items]);

	// Collect all unique field keys across all items (preserve insertion order,
	// skip 'validation'), then append any key that exists only as a derived
	// value.
	//
	// A cost price the invoice never printed a column for is the whole reason
	// for the second pass: it lives in validation.derived_fields, never on the
	// item, so building the columns from item keys alone gave it nowhere to
	// render and the figure was visible only inside an expanded row. Derived
	// keys go last so the invoice's own columns keep the order it printed them
	// in.
	const fieldKeys = useMemo(() => {
		const keys: string[] = [];
		const seen = new Set<string>();
		for (const item of items) {
			for (const key of Object.keys(item)) {
				if (key !== 'validation' && !seen.has(key)) {
					seen.add(key);
					keys.push(key);
				}
			}
		}
		for (let idx = 0; idx < items.length; idx++) {
			for (const key of Object.keys(effectiveDerivedFields(idx))) {
				if (!seen.has(key)) {
					seen.add(key);
					keys.push(key);
				}
			}
		}
		return keys;
		// effectiveDerivedFields reads pluSelections: picking a PLU can derive a
		// cost for a row that had none, which needs a column of its own.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [items, pluSelections]);

	// chevron + # + fieldKeys + PLU + Match + Status
	const totalCols = fieldKeys.length + 5;

	// Summary stats derived from edits and PLU selections (reactive)
	const stats = useMemo(() => {
		let effectiveValid = 0;
		let effectiveIssues = 0;
		let noMatch = 0;
		let pending = 0;
		let totalAccepted = 0;
		let rowsWithAccepted = 0;

		for (let idx = 0; idx < items.length; idx++) {
			const v = items[idx].validation;
			const pluSel = pluSelections[idx];
			const hasSel = !!pluSel;

			// A no-match item the user hasn't resolved via a suggestion is unmatched;
			// once a candidate is selected it behaves like a resolved match.
			if (v.match_type === 'no_match' && !hasSel) {
				noMatch++;
				continue;
			}
			if (v.match_type === 'multi_plu' && !hasSel) {
				pending++;
				continue;
			}

			const effectiveDiscrepanciesRaw = hasSel ? pluSel.discrepancies : v.discrepancies;

			let acceptedInRow = 0;
			let remaining = 0;
			for (const d of effectiveDiscrepanciesRaw) {
				if (isResolved(d, acceptedFields[idx])) {
					totalAccepted++;
					acceptedInRow++;
				} else {
					remaining++;
				}
			}
			if (acceptedInRow > 0) rowsWithAccepted++;

			// A selection replaces the backend's verdict entirely: its discrepancies
			// are the whole story, so `remaining === 0` already covers it.
			const effectivelyValid = (!hasSel && v.is_valid) || remaining === 0;
			if (effectivelyValid) effectiveValid++;
			else effectiveIssues++;
		}

		return {
			effectiveValid,
			effectiveIssues,
			noMatch,
			pending,
			totalAccepted,
			rowsWithAccepted,
		};
	}, [items, pluSelections, acceptedFields]);

	// ---------------------------------------------------------------------------
	// Calculation validation — runs for every item, reactive to edits.
	// ---------------------------------------------------------------------------
	const calcResults = useMemo((): CalcValidationResult | null => {
		const lineResults: LineCalcResult[] = [];
		const subtotalContributions: SubtotalLineContribution[] = [];
		let lineAmountSum = 0;
		let allLinesHaveAmount = true;
		let linesWithAmount = 0;
		let subtotalSum = 0;
		let linesWithSubtotal = 0;
		let subtotalPartial = false;
		let subtotalDiscountApplied = 0;

		// Decided across the whole invoice, so a line whose amount reconciles on
		// neither basis is still reported against the one this vendor prints.
		const amountBasis = lineAmountBasis(items);

		for (let idx = 0; idx < items.length; idx++) {
			const item = items[idx] as Record<string, unknown>;

			// Build effectiveItem — overlay every accepted edit so all calc fields re-run correctly.
			const effectiveItem: Record<string, unknown> = { ...item };
			const itemEdits = edits[idx];
			const itemAccepted = acceptedFields[idx];
			if (itemEdits && itemAccepted) {
				for (const [field, val] of Object.entries(itemEdits)) {
					if (itemAccepted.has(field)) effectiveItem[field] = val;
				}
			}

			// A PLU the user picked re-derives the cost against its own pack size,
			// so it outranks whatever the backend matched. An accepted edit still
			// outranks both — a value the user typed is the last word.
			const pluSel = pluSelections[idx];
			const derivedCost =
				(pluSel ? pluSel.derived : items[idx].validation?.derived_fields?.cost_price) ??
				null;
			const costEdited = itemAccepted?.has('cost_price') ?? false;

			const effectiveCostPrice = parseFloat(
				String(
					costEdited
						? effectiveItem['cost_price']
						: (derivedCost?.value ?? effectiveItem['cost_price'] ?? ''),
				),
			);
			const taxAmountField = findFieldValue(effectiveItem, TAX_AMOUNT_CANDIDATES);
			const lineAmtField = findFieldValue(effectiveItem, LINE_AMOUNT_CANDIDATES);
			const quantity = parseFloat(String(effectiveItem['quantity'] ?? ''));

			// A cost price is per individual unit, while an invoice quantity counts
			// packs — 5 Pkts of 10 is 50 units. Without the pack size the line total
			// comes out short by exactly that factor.
			const uomQtyRaw = derivedCost?.uom_qty ?? num(effectiveItem['uom_qty']);
			const packSize =
				uomQtyRaw !== null && uomQtyRaw !== undefined && uomQtyRaw > 0 ? uomQtyRaw : 1;
			const totalUnits =
				derivedCost?.total_units != null && derivedCost.total_units > 0
					? derivedCost.total_units
					: quantity * packSize;

			// The cost price on screen is rounded to the paisa. Scaling that rounded
			// figure by 50 units magnifies the error past any sane tolerance, so the
			// check multiplies the exact derivation when one is available.
			const exactCostPrice =
				!costEdited &&
				derivedCost?.base_unit_cost !== undefined &&
				derivedCost?.tax_per_unit !== undefined
					? derivedCost.base_unit_cost + derivedCost.tax_per_unit
					: effectiveCostPrice;

			// A discount changes what every line figure is based on: the taxable
			// value is the discounted base, a "Gross Amount" is the pre-discount
			// one, and a printed cost price is the pre-discount unit cost.
			const disc = lineDiscount(effectiveItem);

			// The cost the line amount is built on. A printed cost that reached us
			// undiscounted — a run from before the backend did this, or one the
			// user has not edited — is discounted here, so the vendor's discount is
			// never reported back to them as an arithmetic error.
			let checkCost = exactCostPrice;
			let costLabel = trimNum(effectiveCostPrice);
			let locallyDiscountedCost: number | null = null;
			if (!derivedCost && !costEdited && disc && !isNaN(effectiveCostPrice)) {
				const net = netUnitPrice(effectiveCostPrice, totalUnits, disc);
				if (net !== null) {
					checkCost = net;
					locallyDiscountedCost = net;
					costLabel = `(${trimNum(effectiveCostPrice)} − ${discountTerms(disc, totalUnits).join(' − ')})`;
				}
			}

			const checks: CalcCheck[] = [];

			// —— Resolve each printed figure on a basis we can name ————————
			// GST components and taxable/amount columns are whole-line figures by
			// invoice convention; a unit price is per invoice UOM; a cost price is
			// per catalog unit. Comparing across bases is what made the old checks
			// wrong, so every check below works in one stated basis and skips
			// outright when it cannot establish one. A skipped check is honest; a
			// false "Calc error" is not.
			const unitPriceField = findFieldOrdered(effectiveItem, UNIT_PRICE_CANDIDATES);
			const gstSplit =
				sumFields(effectiveItem, GST_SPLIT_AMOUNT_CANDIDATES) ??
				sumFields(effectiveItem, GST_SPLIT_BARE_CANDIDATES);

			let taxableField = findFieldOrdered(effectiveItem, TAXABLE_VALUE_CANDIDATES);
			// On a discounted line the loose candidates are gross figures, not the
			// taxable base — computing it from the discounted rate is the honest
			// basis there.
			if (!taxableField && !disc) {
				// A bare "total" is the pre-tax base only when a larger tax-inclusive
				// amount sits beside it. Equal values mean a nil-rated line or a
				// tax-inclusive total — neither is safe to treat as taxable.
				const loose = findFieldOrdered(effectiveItem, AMBIGUOUS_TAXABLE_CANDIDATES);
				if (
					loose &&
					lineAmtField &&
					loose.key !== lineAmtField.key &&
					lineAmtField.value > loose.value
				) {
					taxableField = loose;
				}
			}

			// Line-level mode: the invoice splits its GST out or names a taxable
			// value, so the whole-line basis is established rather than guessed.
			const lineLevel = !!gstSplit || !!taxableField;
			const lineTax = gstSplit
				? { value: gstSplit.value, field: null as string | null }
				: taxAmountField
					? { value: taxAmountField.value, field: taxAmountField.key }
					: null;

			// An invoice names the tax rate all sorts of ways, so this searches the
			// candidate spellings rather than reading one key. `effectiveItem`
			// already carries any accepted edit, so a corrected rate is picked up
			// here too.
			const taxPctField = findFieldOrdered(effectiveItem, TAX_PCT_CANDIDATES);
			const linePct = taxPctField?.value ?? NaN;

			// Unit price x qty, less the line's discount when it prints one —
			// scheme and discount amounts first, then the percentage on the
			// remainder, the order the invoice itself computes it in.
			//
			// Rounded to the paisa here, because the invoice is: it prints each
			// line to two decimals and adds up those printed figures. Carrying
			// the full-precision value instead leaves a fraction of a paisa on
			// every discounted line — 7% of 522.06 is 485.5158 against a printed
			// 485.52 — and twenty of those accumulate into a subtotal a whole
			// paisa short of the invoice's own, which the reconciliation then
			// reports as a mismatch against a document that is perfectly correct.
			let computedTaxable: number | null = null;
			let taxableFormula = '';
			if (unitPriceField && !isNaN(quantity)) {
				const gross = round2(unitPriceField.value * quantity);
				taxableFormula = `${trimNum(unitPriceField.value)} × ${trimNum(quantity)}`;
				if (disc) {
					const net = netUnitPrice(gross, 1, disc);
					if (net !== null) {
						computedTaxable = round2(net);
						const legs: string[] = [];
						if (disc.scheme) legs.push(`${trimNum(disc.scheme)} scheme`);
						if (disc.amount) legs.push(`${trimNum(disc.amount)} disc`);
						if (disc.pct) legs.push(`${trimNum(disc.pct)}%`);
						taxableFormula = `(${taxableFormula} − ${legs.join(' − ')})`;
					}
				} else {
					computedTaxable = gross;
				}
			}
			const lineTaxable = taxableField?.value ?? computedTaxable;

			if (lineLevel) {
				// Check 1 — Taxable Value = Unit Price x Qty (less discount)   (line basis)
				// Only worth running against a printed column; against our own
				// computed base it would merely restate itself.
				if (taxableField && computedTaxable !== null) {
					const calculated = computedTaxable;
					checks.push({
						label: 'Taxable Value',
						field: taxableField.key,
						formula: taxableFormula,
						calculated,
						actual: taxableField.value,
						ok: Math.abs(calculated - taxableField.value) <= 0.05,
					});
				}

				// Check 2 — Tax Amount = Taxable x Tax% / 100   (line basis)
				if (lineTaxable !== null && !isNaN(linePct) && lineTax) {
					const calculated = parseFloat(((lineTaxable * linePct) / 100).toFixed(2));
					checks.push({
						label: 'Tax Amount',
						field: lineTax.field ?? '',
						formula: `${trimNum(lineTaxable)} × ${trimNum(linePct)}% ÷ 100`,
						calculated,
						actual: lineTax.value,
						ok: Math.abs(calculated - lineTax.value) <= 0.05,
						acceptable: lineTax.field !== null,
					});
				}

				// Check 3 — Line Amount = Taxable + Tax   (line basis)
				// Stronger than scaling a cost price back up, and free of the rounding
				// amplification that comes with multiplying a per-unit figure.
				if (lineTaxable !== null && lineTax && lineAmtField) {
					const calculated = parseFloat((lineTaxable + lineTax.value).toFixed(2));
					checks.push({
						label: 'Line Amount',
						field: lineAmtField.key,
						formula: `${trimNum(lineTaxable)} + ${trimNum(lineTax.value)}`,
						calculated,
						actual: lineAmtField.value,
						ok: Math.abs(calculated - lineAmtField.value) <= 0.05,
					});
				}

				// Check 4 — Cost Price = Line Amount / total units   (unit basis)
				// Skipped when the cost was derived from these very figures, where it
				// could only ever restate them or report its own rounding. A printed
				// cost with its discount taken off was not, so it is still checked.
				if (
					(!derivedCost || derivedCost.source === 'printed_discount') &&
					!isNaN(effectiveCostPrice) &&
					totalUnits > 0 &&
					lineAmtField
				) {
					const calculated = parseFloat((lineAmtField.value / totalUnits).toFixed(2));
					checks.push({
						label: 'Cost Price',
						field: 'cost_price',
						formula:
							packSize > 1
								? `${trimNum(lineAmtField.value)} ÷ (${trimNum(quantity)} × ${trimNum(packSize)})`
								: `${trimNum(lineAmtField.value)} ÷ ${trimNum(quantity)}`,
						calculated,
						actual: parseFloat(checkCost.toFixed(2)),
						ok: Math.abs(calculated - checkCost) <= 0.02,
					});
				}
			} else {
				// —— Per-unit mode ————————————————
				// No GST split and no taxable column: the invoice prints rate, tax and
				// cost side by side, all per unit.
				//
				// The tax and cost checks that used to live here compared against a
				// "base rate" column, but the backend normalises every spelling of it
				// (rate / b.rate / basic rate / unit price) onto invoice_price before
				// the item reaches us, so they could never fire.

				// The printed amount has two admissible bases here, and which one a
				// vendor uses is a property of the template, not of the line:
				//
				//   pre-tax         rate x qty, less the line's discount
				//   tax-inclusive   that same base plus the line's GST — read off
				//                   the cost price when one is available, else
				//                   grossed up at the line's own rate
				//
				// Both are checked and the line passes on either, because an invoice
				// that totals its lines before tax and charges the GST in the
				// summary is not broken. What `amountBasis` decides is which one is
				// *reported* when both fail: quoting a tax-inclusive expectation at
				// a pre-tax column names the wrong figure as the correct one, which
				// is worse than not checking at all. That was the hole a wrong
				// pre-tax amount used to fall through — with no cost price
				// derivable there was no check on the line whatsoever.
				const preTax = computedTaxable;
				const amt = lineAmtField?.value ?? NaN;

				const bases: Array<{
					calculated: number;
					formula: string;
					taxInclusive: boolean;
					ok: boolean;
				}> = [];

				if (preTax !== null) {
					bases.push({
						calculated: preTax,
						formula: taxableFormula,
						taxInclusive: false,
						ok: Math.abs(preTax - amt) <= 0.05,
					});
				}
				if (!isNaN(effectiveCostPrice) && !isNaN(quantity) && totalUnits > 0) {
					const calculated = round2(checkCost * totalUnits);
					// Every unit carries up to half a paisa of rounding, so a flat
					// 0.02 reads a 50-unit line as broken when it is merely rounded.
					bases.push({
						calculated,
						formula:
							packSize > 1
								? `${costLabel} × ${trimNum(quantity)} × ${trimNum(packSize)}`
								: `${costLabel} × ${trimNum(quantity)}`,
						taxInclusive: true,
						ok: Math.abs(calculated - amt) <= Math.max(0.02, 0.005 * totalUnits),
					});
				} else if (preTax !== null && !isNaN(linePct)) {
					// No catalog row to price the units, but the line states its own
					// rate — enough to test the tax-inclusive basis on its own terms.
					const calculated = round2(preTax * (1 + linePct / 100));
					bases.push({
						calculated,
						formula: `${taxableFormula} + ${trimNum(linePct)}% GST`,
						taxInclusive: true,
						ok: Math.abs(calculated - amt) <= 0.05,
					});
				}

				if (lineAmtField && bases.length) {
					// Nothing on the line says which slab applies and the other lines
					// did not agree on a basis either, so an amount that is the
					// pre-tax base grossed up by *some* standard slab is taken as a
					// tax-inclusive column. Guessing wrong here would flag every line
					// of a perfectly ordinary invoice.
					const slabOk =
						amountBasis === 'unknown' &&
						!bases.some((b) => b.taxInclusive) &&
						preTax !== null &&
						GST_SLABS.some((r) => Math.abs(round2(preTax * (1 + r / 100)) - amt) <= 0.05);

					const chosen =
						bases.find((b) => b.ok) ??
						(amountBasis === 'pre_tax'
							? bases.find((b) => !b.taxInclusive)
							: bases.find((b) => b.taxInclusive)) ??
						bases[0];

					checks.push({
						label: 'Line Amount',
						field: lineAmtField.key,
						formula: chosen.formula,
						calculated: chosen.calculated,
						actual: lineAmtField.value,
						ok: bases.some((b) => b.ok) || slabOk,
					});
				}
			}

			if (lineAmtField) {
				lineAmountSum += lineAmtField.value;
				linesWithAmount += 1;
			} else {
				allLinesHaveAmount = false;
			}

			// —— Subtotal — this line's taxable value ————————————————
			// Each line stands on its own tax rate rather than a blended one:
			// `lineTaxable` (printed taxable-value column, or unit price × qty
			// less the line's own discount) is the pre-tax base. Only when neither
			// is on hand does this fall back to backing the tax out of the printed
			// line amount, or — with no tax information at all — treating the
			// whole line amount as its own taxable base.
			let subtotalBasis: number | null = lineTaxable;
			let taxableSource: SubtotalLineContribution['taxableSource'] =
				subtotalBasis !== null ? (taxableField ? 'printed' : 'computed') : 'none';
			if (subtotalBasis === null && lineAmtField && lineTax) {
				subtotalBasis = parseFloat((lineAmtField.value - lineTax.value).toFixed(2));
				taxableSource = 'back_out';
			} else if (subtotalBasis === null && lineAmtField && !lineTax) {
				subtotalBasis = lineAmtField.value;
				taxableSource = 'line_amount';
			}

			if (subtotalBasis !== null) {
				subtotalSum += subtotalBasis;
				linesWithSubtotal += 1;
				// The rupee discount this line already carries, so a summary
				// discount that merely restates the line discounts is not taken off
				// again.
				if (disc && computedTaxable !== null && unitPriceField && !isNaN(quantity)) {
					const gross = round2(unitPriceField.value * quantity);
					subtotalDiscountApplied += Math.max(0, round2(gross - computedTaxable));
				}
			} else {
				subtotalPartial = true;
			}

			subtotalContributions.push({
				idx,
				name: String(
					effectiveItem['sku_description'] ??
						effectiveItem['product_name'] ??
						effectiveItem['description'] ??
						`Row ${idx + 1}`,
				),
				taxable: subtotalBasis,
				taxableSource,
				tax: lineTax?.value ?? null,
				lineAmount: lineAmtField?.value ?? null,
			});

			lineResults.push({ idx, checks });
		}

		// Grand total check. Subtotal (computed from the line items, each on its
		// own tax rate) + Tax (read from the invoice summary) is reconciled
		// against the invoice's printed grand total; the printed line sum is
		// kept alongside as a cross-check. Built even when no total field is
		// found: hiding the panel outright made an undetected header
		// indistinguishable from a clean match, so the figures are still shown
		// and the missing side is named.
		let grandTotalCheck: CalcValidationResult['grandTotalCheck'] = null;
		if (documentScalars && items.length > 0) {
			const gtField = findGrandTotal(documentScalars);
			const documentTotal = gtField?.value ?? null;
			const sumRounded = parseFloat(lineAmountSum.toFixed(2));
			const computedSubtotal = parseFloat(subtotalSum.toFixed(2));
			const summary = findSummaryFigures(documentScalars, gtField?.key ?? null);
			// The tax the lines themselves print, for invoices whose summary
			// block prints none. Only when *every* line counted into the subtotal
			// printed a tax figure: a partial sum would be a made-up total, and a
			// line with no tax fields at all is one whose taxable basis is its own
			// (tax-inclusive) amount, which this must never be added on top of.
			const includedLines = subtotalContributions.filter((c) => c.taxable !== null);
			const lineTaxComplete =
				!summary.taxTotal &&
				includedLines.length > 0 &&
				includedLines.every((c) => c.tax !== null);
			const lineTaxTotal = lineTaxComplete
				? parseFloat(
						includedLines.reduce((acc, c) => acc + (c.tax ?? 0), 0).toFixed(2),
					) || null
				: null;
			const recon = reconcileGrandTotal(
				computedSubtotal,
				linesWithSubtotal,
				summary,
				documentTotal,
				subtotalDiscountApplied,
				lineTaxTotal,
			);
			grandTotalCheck = {
				field: gtField?.key ?? null,
				documentTotal,
				ok: recon.ok,
				lineSumOk:
					documentTotal !== null &&
					Math.abs(sumRounded - documentTotal) <= GRAND_TOTAL_TOLERANCE,
				linesCounted: linesWithAmount,
				linesTotal: lineResults.length,
				partial: !allLinesHaveAmount,
				subtotal: computedSubtotal,
				subtotalLinesIncluded: linesWithSubtotal,
				subtotalPartial,
				contributions: subtotalContributions,
				steps: recon.steps,
				expectedTotal: recon.expected,
				subtotalDiscountApplied: parseFloat(subtotalDiscountApplied.toFixed(2)),
				coveredDiscounts: recon.coveredDiscounts,
				printedSubtotal: summary.printedSubtotal,
				taxTotal: summary.taxTotal,
			};
		}

		return {
			lineResults,
			lineAmountSum: parseFloat(lineAmountSum.toFixed(2)),
			grandTotalCheck,
		};
	}, [items, edits, acceptedFields, documentScalars, pluSelections]);

	function toggleExpand(idx: number) {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(idx)) {
				// Collapsing — fire skipped_reasoning if the user opened it but never interacted.
				const hadInteraction =
					(acceptedFields[idx]?.size ?? 0) > 0 ||
					(dismissedFields[idx]?.size ?? 0) > 0 ||
					(editingDiscrepancy[idx]?.size ?? 0) > 0 ||
					editingRow.has(idx) ||
					!!pluSelections[idx] ||
					!!itemOutcomes[idx];
				// Only a row that actually raised something counts as reasoning the
				// user skipped — clean rows open onto their editor, and reading one
				// is not a signal that explanations are too long.
				const v = items[idx]?.validation;
				const hadReasoning =
					(v?.discrepancies?.length ?? 0) > 0 ||
					v?.match_type !== undefined ||
					(calcResults?.lineResults
						.find((r) => r.idx === idx)
						?.checks.some((c) => !c.ok) ??
						false);
				if (!hadInteraction && hadReasoning) {
					track('skipped_reasoning', {
						item_index: idx,
						match_type: items[idx]?.validation?.match_type,
					});
				}
				next.delete(idx);
			} else {
				// Expanding — fire expanded_breakdown.
				track('expanded_breakdown', {
					item_index: idx,
					match_type: items[idx]?.validation?.match_type,
				});
				next.add(idx);
			}
			return next;
		});
	}

	// Expands a line (if not already) and scrolls it into view — used by the
	// Grand Total panel to jump straight to the line it says is causing a
	// shortfall, rather than leaving the user to scroll and hunt for it.
	function goToLine(itemIdx: number) {
		setExpanded((prev) => (prev.has(itemIdx) ? prev : new Set(prev).add(itemIdx)));
		requestAnimationFrame(() => {
			rowRefs.current
				.get(itemIdx)
				?.scrollIntoView({ behavior: 'smooth', block: 'center' });
		});
	}

	function setFieldEdit(itemIdx: number, field: string, value: string) {
		setEdits((prev) => ({
			...prev,
			[itemIdx]: { ...(prev[itemIdx] ?? {}), [field]: value },
		}));
	}

	function applyAllSuggestions(
		itemIdx: number,
		corrections: ValidationResult['suggested_corrections'],
	) {
		const updates: Record<string, string> = {};
		const fields = new Set<string>();
		for (const [field, val] of Object.entries(corrections)) {
			updates[field] = String(val);
			fields.add(field);
		}
		setEdits((prev) => ({
			...prev,
			[itemIdx]: { ...(prev[itemIdx] ?? {}), ...updates },
		}));
		setAcceptedFields((prev) => ({
			...prev,
			[itemIdx]: new Set([...(prev[itemIdx] ?? []), ...fields]),
		}));

		track('suggestion_accepted', {
			fields: [...fields],
			item_index: itemIdx,
			match_type: items[itemIdx]?.validation?.match_type ?? 'exact',
			bulk: true,
		});

		for (const [field, val] of Object.entries(corrections)) {
			recordFieldCorrection(
				items[itemIdx]?.validation?.matched_plu ?? null,
				items[itemIdx]?.ean_code ?? null,
				field,
				String(val),
				sourceFilename,
			);
		}
	}

	function acceptField(itemIdx: number, field: string, value: string) {
		setEdits((prev) => ({
			...prev,
			[itemIdx]: { ...(prev[itemIdx] ?? {}), [field]: value },
		}));
		setAcceptedFields((prev) => ({
			...prev,
			[itemIdx]: new Set([...(prev[itemIdx] ?? []), field]),
		}));
		setEditingDiscrepancy((prev) => {
			const set = new Set(prev[itemIdx] ?? []);
			set.delete(field);
			return { ...prev, [itemIdx]: set };
		});

		// Determine if user accepted the master suggestion unchanged, or typed their own value.
		const suggestedValue = String(
			items[itemIdx]?.validation?.suggested_corrections?.[field] ?? '',
		);
		const isSuggestion = value === suggestedValue && suggestedValue !== '';
		const existingHint = getHint(items[itemIdx], field);
		const isOverride = Boolean(existingHint) && existingHint!.corrected_value !== value;
		const trackEvent = isOverride
			? 'field_correction_overridden'
			: isSuggestion
				? 'suggestion_accepted'
				: 'field_edit';
		track(trackEvent, {
			field_id: field,
			item_index: itemIdx,
			match_type: items[itemIdx]?.validation?.match_type ?? 'exact',
			had_hint: Boolean(existingHint),
		});

		recordFieldCorrection(
			items[itemIdx]?.validation?.matched_plu ?? null,
			items[itemIdx]?.ean_code ?? null,
			field,
			value,
			sourceFilename,
		);
	}

	function openFieldEdit(itemIdx: number, field: string) {
		setEditingDiscrepancy((prev) => ({
			...prev,
			[itemIdx]: new Set([...(prev[itemIdx] ?? []), field]),
		}));

		track('flag_acknowledged', {
			field_id: field,
			item_index: itemIdx,
			match_type: items[itemIdx]?.validation?.match_type ?? 'exact',
		});
	}

	function cancelFieldEdit(itemIdx: number, field: string) {
		setEditingDiscrepancy((prev) => {
			const set = new Set(prev[itemIdx] ?? []);
			set.delete(field);
			return { ...prev, [itemIdx]: set };
		});
	}

	function getEditValue(itemIdx: number, field: string, actual: unknown): string {
		return edits[itemIdx]?.[field] ?? String(actual ?? '');
	}

	function cancelRowEdit(itemIdx: number) {
		setEditingRow((prev) => {
			const next = new Set(prev);
			next.delete(itemIdx);
			return next;
		});
	}

	// Commits the row editor. `markAll` preserves the unmatched-row behaviour of
	// stamping every field as accepted; a matched row only marks what the user
	// actually changed, so a clean match is not repainted green throughout.
	function saveRowEdits(itemIdx: number, markAll: boolean) {
		const item = items[itemIdx];
		const itemEdits = edits[itemIdx] ?? {};
		const changed = new Set<string>();
		const accepted = new Set<string>();

		for (const key of fieldKeys) {
			if (markAll) accepted.add(key);
			const edited = itemEdits[key];
			if (edited !== undefined && edited !== String(item[key] ?? '')) {
				changed.add(key);
				accepted.add(key);
			}
		}

		setAcceptedFields((prev) => ({
			...prev,
			[itemIdx]: new Set([...(prev[itemIdx] ?? []), ...accepted]),
		}));
		cancelRowEdit(itemIdx);

		if (changed.size === 0) return;
		track('field_edit', {
			fields: [...changed],
			item_index: itemIdx,
			match_type: item.validation?.match_type ?? 'exact',
			bulk: true,
		});
		for (const field of changed) {
			recordFieldCorrection(
				item.validation?.matched_plu ?? null,
				item.ean_code ?? null,
				field,
				itemEdits[field],
				sourceFilename,
			);
		}
	}

	function selectPlu(
		itemIdx: number,
		opt: PluOption,
		fromAdditional = false,
		fromSearch = false,
	) {
		const { discrepancies, corrections, derived } = computeLocalValidation(items[itemIdx], opt);
		setPluSelections((prev) => ({
			...prev,
			[itemIdx]: { plu_code: opt.plu_code, discrepancies, corrections, derived },
		}));

		const v = items[itemIdx]?.validation;
		track('plu_selected', {
			plu_code: opt.plu_code,
			item_index: itemIdx,
			options_count: v?.plu_options?.length ?? 0,
			// A pick from the revealed tail means the ranking put the right
			// record below the shortlist — the one measurement that says whether
			// recommendation quality still needs work.
			considered_count:
				(v?.plu_options?.length ?? 0) + (v?.additional_plu_options?.length ?? 0),
			from_additional: fromAdditional,
			// Typed into the catalogue box rather than picked from what we
			// offered — the measure of how often the offer was no use at all.
			from_search: fromSearch,
		});
		setEdits((prev) => {
			const next = { ...prev };
			delete next[itemIdx];
			return next;
		});
		setAcceptedFields((prev) => {
			const next = { ...prev };
			delete next[itemIdx];
			return next;
		});
		setEditingDiscrepancy((prev) => {
			const next = { ...prev };
			delete next[itemIdx];
			return next;
		});
	}

	function clearPluSelection(itemIdx: number) {
		setPluSelections((prev) => {
			const next = { ...prev };
			delete next[itemIdx];
			return next;
		});
		setEdits((prev) => {
			const next = { ...prev };
			delete next[itemIdx];
			return next;
		});
		setAcceptedFields((prev) => {
			const next = { ...prev };
			delete next[itemIdx];
			return next;
		});
		setEditingDiscrepancy((prev) => {
			const next = { ...prev };
			delete next[itemIdx];
			return next;
		});
	}

	function fireFeedback(idx: number, eventType: string) {
		track(eventType);
		setFeedbackFlash((prev) => ({ ...prev, [idx]: eventType }));
		setTimeout(() => {
			setFeedbackFlash((prev) => {
				const next = { ...prev };
				delete next[idx];
				return next;
			});
		}, 1500);
	}

	function getHint(item: ValidatedItem, field: string): FieldHint | undefined {
		const plu = item.validation?.matched_plu;
		if (plu) return hintMap.get(`${plu}:${field}`);
		const ean = item.ean_code;
		if (ean) return hintMap.get(`${ean}:${field}`);
		return undefined;
	}

	function applyHint(itemIdx: number, field: string, hintValue: string) {
		setEdits((prev) => ({
			...prev,
			[itemIdx]: { ...(prev[itemIdx] ?? {}), [field]: hintValue },
		}));
		setAcceptedFields((prev) => ({
			...prev,
			[itemIdx]: new Set([...(prev[itemIdx] ?? []), field]),
		}));
		setEditingDiscrepancy((prev) => {
			const set = new Set(prev[itemIdx] ?? []);
			set.delete(field);
			return { ...prev, [itemIdx]: set };
		});
		track('field_correction_accepted', {
			field,
			plu_code: items[itemIdx]?.validation?.matched_plu,
			hint_count: getHint(items[itemIdx], field)?.count,
		});
		recordFieldCorrection(
			items[itemIdx]?.validation?.matched_plu ?? null,
			items[itemIdx]?.ean_code ?? null,
			field,
			hintValue,
			sourceFilename,
		);
	}

	function toggleAutoSelectPlu() {
		const next = !autoSelectPlu;
		setAutoSelectPlu(next);
		updateUserPreferences({ auto_select_plu: next });
		track('plu_auto_select_toggled', { enabled: next });

		if (next) {
			// Immediately auto-select best available PLU for every pending multi_plu item.
			// "Best" = fewest discrepancies; ties broken by array order (backend priority).
			items.forEach((item, idx) => {
				if (item.validation.match_type !== 'multi_plu') return;
				if (pluSelections[idx]) return; // already resolved
				const opts = item.validation.plu_options;
				if (!opts?.length) return;
				const best = opts.reduce((a, b) => {
					const da = computeLocalValidation(item, a).discrepancies.length;
					const db = computeLocalValidation(item, b).discrepancies.length;
					return db < da ? b : a;
				});
				selectPlu(idx, best);
			});
		}
	}

	function dismissField(itemIdx: number, field: string) {
		setDismissedFields((prev) => ({
			...prev,
			[itemIdx]: new Set([...(prev[itemIdx] ?? []), field]),
		}));
		recordDismissal(getDiscrepancyFlagType(field));
	}

	function recordItemOutcome(itemIdx: number, outcome: string) {
		setItemOutcomes((prev) => ({ ...prev, [itemIdx]: outcome }));
		const flagType = getItemFlagType(items[itemIdx]?.validation?.match_type);
		recordInvestigation(flagType, outcome, sourceFilename);
	}

	// Values worked out rather than read off the invoice, for one row. A PLU
	// the user picked re-derives the cost locally against its own pack size,
	// so its derivation outranks whatever the backend attached. The table
	// cells and the CSV must both read from here — the export once read only
	// the raw item and so wrote a blank where the screen showed a derived cost.
	function effectiveDerivedFields(idx: number): Record<string, DerivedField> {
		const pluSel = pluSelections[idx];
		if (pluSel) return pluSel.derived ? { cost_price: pluSel.derived } : {};
		return items[idx]?.validation?.derived_fields ?? {};
	}

	function downloadValidationCsv() {
		// fieldKeys already carries the keys that exist only as derived values —
		// a cost price worked out from pack size and tax — so the export and the
		// table now write the same columns.
		const exportKeys = fieldKeys;

		const headers = [
			...exportKeys.map(fieldLabel),
			'Matched PLU',
			'Match Type',
			'Status',
			'Remaining Issues',
		];

		const rows = items.map((item, idx) => {
			const v = item.validation;
			const pluSel = pluSelections[idx];
			const itemEdits = edits[idx];

			// Field values — same precedence as the table cell: a user edit wins,
			// then a value derived for this row, then whatever the invoice printed.
			const derivedFields = effectiveDerivedFields(idx);
			const fieldVals = exportKeys.map((key) => {
				const raw = (() => {
					const edited = itemEdits?.[key];
					if (edited !== undefined) return edited;
					const isAccepted = acceptedFields[idx]?.has(key) ?? false;
					const derived = !isAccepted ? derivedFields[key] : undefined;
					if (derived) return String(derived.value);
					return String(item[key] ?? '');
				})();
				// Identifier columns must survive Excel with every digit intact.
				return CODE_COLUMN_RE.test(key) ? csvTextCell(raw) : raw;
			});

			// Matched PLU — a pick from any picker or the catalogue search wins.
			const matchedPlu = csvTextCell(
				pluSel?.plu_code ?? (v.match_type === 'multi_plu' ? '' : (v.matched_plu ?? '')),
			);

			// Match type label
			const matchTypeLabel =
				v.match_type === 'multi_plu'
					? pluSel
						? 'Multi PLU'
						: 'Multi PLU (pending)'
					: v.match_type === 'fuzzy_name'
						? 'Fuzzy'
						: v.match_type === 'no_match'
							? 'No Match'
							: 'Exact';

			// Remaining unresolved discrepancies
			const effectiveDiscrepanciesRaw = pluSel ? pluSel.discrepancies : v.discrepancies;
			const remaining = effectiveDiscrepanciesRaw.filter(
				(d) => !isResolved(d, acceptedFields[idx]),
			);

			// Status label
			let status: string;
			if (v.match_type === 'no_match' && !pluSel) status = 'Unmatched';
			else if (v.match_type === 'multi_plu' && !pluSel) status = 'Pending Selection';
			else if (remaining.length === 0) status = 'Valid';
			else status = `${remaining.length} issue${remaining.length !== 1 ? 's' : ''}`;

			const remainingIssues = remaining.map((d) => fieldLabel(d.field)).join('; ');

			return [...fieldVals, matchedPlu, matchTypeLabel, status, remainingIssues];
		});

		// Grand Total breakdown — appended after the line items so the export
		// carries the same reconciliation shown on screen, not just the rows.
		const gt = calcResults?.grandTotalCheck;
		const totalRows: string[][] = [];
		if (gt) {
			const money = (n: number) => n.toFixed(2);
			totalRows.push([]);
			totalRows.push(['Grand Total Breakdown']);
			for (const st of gt.steps) {
				totalRows.push([
					st.label + (st.fields.length > 0 ? ` (${st.fields.join(' + ')})` : ''),
					money(st.amount),
				]);
			}
			totalRows.push(['Expected Grand Total', money(gt.expectedTotal)]);
			totalRows.push([
				'Invoice Grand Total' + (gt.field ? ` (${gt.field})` : ''),
				gt.documentTotal !== null ? money(gt.documentTotal) : 'Not detected',
			]);
			totalRows.push([
				'Match',
				gt.documentTotal === null ? 'N/A' : gt.ok ? 'Match' : 'Mismatch',
			]);
		}

		const escape = (s: string) =>
			s.includes(',') || s.includes('"') || s.includes('\n')
				? `"${s.replace(/"/g, '""')}"`
				: s;

		const csv = [headers, ...rows, ...totalRows]
			.map((row) => row.map((cell) => escape(String(cell ?? ''))).join(','))
			.join('\n');

		const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'validation_results.csv';
		a.click();
		URL.revokeObjectURL(url);
	}

	if (items.length === 0) {
		return (
			<div className='flex flex-col items-center justify-center py-12 text-muted-foreground'>
				<p className='font-medium'>No line items to validate</p>
				<p className='text-sm mt-1'>
					The document has no item arrays to validate against master data.
				</p>
			</div>
		);
	}

	return (
		<TooltipProvider>
			<div ref={containerRef} className='space-y-3'>
				{/* Summary bar */}
				<div className='p-3 bg-muted/40 rounded-lg space-y-1.5'>
					<div className='flex items-center gap-3 text-sm flex-wrap'>
						<span className='font-medium text-foreground'>
							{items.length} item{items.length !== 1 ? 's' : ''}
						</span>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant={autoSelectPlu ? 'default' : 'outline'}
									size='sm'
									className='h-7 text-xs gap-1.5 shrink-0'
									onClick={toggleAutoSelectPlu}>
									Auto-select PLU: {autoSelectPlu ? 'ON' : 'OFF'}
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{autoSelectPlu
									? 'Gemini picks the best PLU automatically (1 credit per ambiguous item). Toggle off to select manually.'
									: 'Toggle on to let Gemini auto-select the best PLU when multiple matches exist (1 credit per item).'}
							</TooltipContent>
						</Tooltip>
						<Button
							variant='outline'
							size='sm'
							className='ml-auto h-7 text-xs gap-1.5 shrink-0'
							onClick={downloadValidationCsv}>
							<Download className='w-3.5 h-3.5' />
							Download CSV
						</Button>
						<span className='text-muted-foreground'>·</span>
						<span className='flex items-center gap-1 text-green-600 dark:text-green-400'>
							<CheckCircle2 className='w-3.5 h-3.5' />
							{stats.effectiveValid} valid
						</span>
						{stats.effectiveIssues > 0 && (
							<>
								<span className='text-muted-foreground'>·</span>
								<span className='flex items-center gap-1 text-destructive'>
									<XCircle className='w-3.5 h-3.5' />
									{stats.effectiveIssues} with issues
								</span>
							</>
						)}
						{stats.pending > 0 && (
							<>
								<span className='text-muted-foreground'>·</span>
								<span className='flex items-center gap-1 text-violet-600 dark:text-violet-400'>
									<Layers className='w-3.5 h-3.5' />
									{stats.pending} pending selection
								</span>
							</>
						)}
						{stats.noMatch > 0 && (
							<>
								<span className='text-muted-foreground'>·</span>
								<span className='flex items-center gap-1 text-muted-foreground'>
									<HelpCircle className='w-3.5 h-3.5' />
									{stats.noMatch} unmatched
								</span>
							</>
						)}
					</div>

					{/* Accepted suggestions metadata — only shown once at least one is accepted */}
					{stats.totalAccepted > 0 && (
						<div className='flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400'>
							<Wand2 className='w-3 h-3' />
							<span>
								<span className='font-semibold'>{stats.totalAccepted}</span>{' '}
								suggestion{stats.totalAccepted !== 1 ? 's' : ''} accepted across{' '}
								<span className='font-semibold'>{stats.rowsWithAccepted}</span> row
								{stats.rowsWithAccepted !== 1 ? 's' : ''}
							</span>
						</div>
					)}
				</div>

				{/* Main table */}
				<Table
					wrapperClassName='overflow-visible'
					className='border border-border rounded-lg'>
						<TableHeader sticky>
							<UITableRow className='bg-muted/50 hover:bg-muted/50'>
								<TableHead className='w-8 px-2' />
								<TableHead className='w-8 text-xs font-semibold text-foreground'>
									#
								</TableHead>
								{fieldKeys.map((key) => (
									<TableHead
										key={key}
										className='text-xs font-semibold text-foreground whitespace-nowrap'>
										{fieldLabel(key)}
									</TableHead>
								))}
								<TableHead className='text-xs font-semibold text-foreground whitespace-nowrap'>
									Matched PLU
								</TableHead>
								<TableHead className='text-xs font-semibold text-foreground whitespace-nowrap'>
									Match
								</TableHead>
								<TableHead className='text-xs font-semibold text-foreground whitespace-nowrap'>
									Status
								</TableHead>
							</UITableRow>
						</TableHeader>

						<TableBody>
							{items.map((item, idx) => {
								const v = item.validation;
								const isExpanded = expanded.has(idx);
								const isFuzzy = v.match_type === 'fuzzy_name';
								const isNoMatch = v.match_type === 'no_match';
								const isMultiPlu = v.match_type === 'multi_plu';
								const isAutoSelected = v.match_type === 'auto_selected';
								const pluSel = pluSelections[idx];
								const hasSelection = !!pluSel;
								// no_match items may carry "considered" candidates to pick from
								const noMatchOptions = isNoMatch ? (v.plu_options ?? []) : [];
								const hasSuggestions = noMatchOptions.length > 0;
								// A no_match item stays unmatched until the user picks a suggestion.
								const stillUnmatched = isNoMatch && !hasSelection;
								// Gemini matched one record but others were plausible — offer the
								// runners-up with its pick highlighted rather than a silent guess.
								const altOptions =
									isFuzzy || isAutoSelected ? (v.plu_options ?? []) : [];
								const hasAlternatives = altOptions.length > 1;
								// Rows that support candidate selection (multi-PLU, no_match with
								// suggestions, or an overridable match) share the picker +
								// comparison UI. Every one of them, plus a bare no-match, can
								// also be resolved from the catalogue search box below.
								const canSearch =
									isNoMatch || isMultiPlu || isFuzzy || isAutoSelected;
								const canSelect =
									isMultiPlu || hasSuggestions || hasAlternatives || canSearch;

								// Build effective validation values (override after a selection)
								const effectiveMatchedPlu = hasSelection
									? pluSel.plu_code
									: isMultiPlu
										? null
										: v.matched_plu;
								const effectiveDiscrepanciesRaw = hasSelection
									? pluSel.discrepancies
									: v.discrepancies;
								const effectiveCorrections = hasSelection
									? pluSel.corrections
									: v.suggested_corrections;
								// Values worked out rather than read off the invoice. A
								// selection re-derives locally, since the pack size that
								// produces the cost belongs to the chosen PLU.
								const derivedFields = effectiveDerivedFields(idx);

								// Remaining unresolved discrepancies
								const effectiveDiscrepancies = effectiveDiscrepanciesRaw.filter(
									(d) => !isResolved(d, acceptedFields[idx]),
								);

								const isPending = isMultiPlu && !pluSel;

								const isEffectivelyValid =
									!isPending &&
									!stillUnmatched &&
									((!hasSelection && v.is_valid) ||
										effectiveDiscrepancies.length === 0);

								// Cells that still have active discrepancies. Discrepancy
								// fields and item keys share one spelling, so this is a
								// straight lookup.
								const discrepantFields = new Set(
									effectiveDiscrepancies.map((d) => d.field),
								);

								const itemCalcResult = calcResults?.lineResults.find(
									(r) => r.idx === idx,
								);
								const hasCalcErrors =
									itemCalcResult?.checks.some((c) => !c.ok) ?? false;

								// Something the validator wants reviewed. Every row expands
								// regardless — a clean match still opens onto its editor —
								// but only these carry a finding worth an outcome.
								const hasFindings =
									v.discrepancies.length > 0 ||
									isFuzzy ||
									isNoMatch ||
									isMultiPlu ||
									hasAlternatives ||
									hasCalcErrors;

								return (
									<Fragment key={idx}>
										{/* Data row */}
										<UITableRow
											ref={(el) => {
												if (el) rowRefs.current.set(idx, el);
												else rowRefs.current.delete(idx);
											}}
											className={`cursor-pointer hover:bg-muted/30 ${
												isExpanded ? 'bg-muted/20' : ''
											}`}
											onClick={() => toggleExpand(idx)}>
											{/* Expand chevron */}
											<TableCell className='px-2 py-2 w-8'>
												{isExpanded ? (
													<ChevronDown className='w-4 h-4 text-muted-foreground' />
												) : (
													<ChevronRight className='w-4 h-4 text-muted-foreground' />
												)}
											</TableCell>

											{/* Row number */}
											<TableCell className='text-xs text-muted-foreground font-mono py-2'>
												{idx + 1}
											</TableCell>

											{/* Dynamic OCR field cells */}
											{fieldKeys.map((key) => {
												const editedVal = edits[idx]?.[key];
												const displayVal =
													editedVal !== undefined ? editedVal : item[key];
												const isAccepted =
													acceptedFields[idx]?.has(key) ?? false;
												// A value we worked out from the invoice's other
												// columns is labelled here too, not only inside the
												// expanded comparison — this row is what most users
												// read.
												const cellDerived =
													editedVal === undefined && !isAccepted
														? (derivedFields[key] ?? null)
														: null;
												return (
													<TableCell
														key={key}
														className={`text-sm py-2 whitespace-nowrap ${
															discrepantFields.has(key)
																? 'text-destructive font-semibold'
																: isAccepted
																	? 'text-green-700 dark:text-green-400 font-medium'
																	: 'text-foreground'
														}`}>
														<span className='inline-flex items-center gap-1.5'>
															{formatCellValue(
																cellDerived
																	? cellDerived.value
																	: displayVal,
															)}
															{cellDerived && (
																<DerivedBadge
																	derived={cellDerived}
																/>
															)}
														</span>
													</TableCell>
												);
											})}

											{/* Matched PLU */}
											<TableCell className='text-sm py-2 font-mono text-foreground whitespace-nowrap'>
												{effectiveMatchedPlu ?? '—'}
											</TableCell>

											{/* Match type badge */}
											<TableCell className='py-2'>
												{isMultiPlu ? (
													<Badge
														variant='outline'
														className='text-violet-600 border-violet-300 bg-violet-50 dark:bg-violet-950/20 text-xs whitespace-nowrap gap-1'>
														<Layers className='w-3 h-3' />
														Multi PLU
													</Badge>
												) : isFuzzy ? (
													<Badge
														variant='outline'
														className='text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/20 text-xs whitespace-nowrap'>
														Fuzzy
														{v.confidence && (
															<span className='ml-1 opacity-70'>
																· {v.confidence}
															</span>
														)}
													</Badge>
												) : isNoMatch ? (
													<Badge
														variant='outline'
														className='text-muted-foreground text-xs whitespace-nowrap'>
														No Match
													</Badge>
												) : isAutoSelected ? (
													<Badge
														variant='outline'
														className='text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/20 text-xs whitespace-nowrap gap-1'>
														<Sparkles className='w-3 h-3' />
														Auto
													</Badge>
												) : (
													<Badge
														variant='outline'
														className='text-blue-600 border-blue-300 bg-blue-50 dark:bg-blue-950/20 text-xs'>
														Exact
													</Badge>
												)}
											</TableCell>

											{/* Status badge — reflects accepted edits and PLU selection */}
											<TableCell className='py-2'>
												<div className='flex flex-col gap-1'>
													{isPending ? (
														<Badge
															variant='outline'
															className='text-violet-600 border-violet-300 bg-violet-50 dark:bg-violet-950/20 text-xs gap-1 whitespace-nowrap'>
															<Layers className='w-3 h-3' />
															Select PLU
														</Badge>
													) : isEffectivelyValid ? (
														<Badge className='bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20 gap-1 text-xs whitespace-nowrap'>
															<CheckCircle2 className='w-3 h-3' />
															Valid
														</Badge>
													) : stillUnmatched ? (
														(acceptedFields[idx]?.size ?? 0) > 0 ? (
															<Badge className='bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 gap-1 text-xs whitespace-nowrap'>
																<CheckCircle2 className='w-3 h-3' />
																Accepted
															</Badge>
														) : (
															<Badge
																variant='outline'
																className='text-muted-foreground text-xs gap-1 whitespace-nowrap'>
																<HelpCircle className='w-3 h-3' />
																Unmatched
															</Badge>
														)
													) : (
														<Badge className='bg-destructive/10 text-destructive border-destructive/20 gap-1 text-xs whitespace-nowrap'>
															<XCircle className='w-3 h-3' />
															{effectiveDiscrepancies.length} issue
															{effectiveDiscrepancies.length !== 1
																? 's'
																: ''}
														</Badge>
													)}
													{hasCalcErrors && (
														<Tooltip>
															<TooltipTrigger asChild>
																<Badge
																	variant='outline'
																	className='text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/20 text-xs gap-1 whitespace-nowrap cursor-default'>
																	<Calculator className='w-3 h-3' />
																	Calc error
																</Badge>
															</TooltipTrigger>
															<TooltipContent>
																Calculation mismatch — expand row to
																review
															</TooltipContent>
														</Tooltip>
													)}
												</div>
											</TableCell>
										</UITableRow>

										{/* Inline expanded detail row */}
										{isExpanded && (
											<tr>
												<td colSpan={totalCols} className='p-0'>
													<div className='bg-muted/10 border-t border-border px-4 py-3 space-y-3'>
														<p className='text-xs font-semibold text-muted-foreground uppercase tracking-wide'>
															Item {idx + 1} —{' '}
															{String(
																item['sku_description'] ??
																	item.product_name ??
																	item.sku_desc ??
																	'details',
															)}
														</p>

														{/* Multi-PLU: PLU selection table */}
														{isMultiPlu && !pluSel && v.plu_options && (
															<div className='border border-violet-200 dark:border-violet-800 rounded-lg overflow-hidden'>
																<div className='px-3 py-2 bg-violet-50 dark:bg-violet-950/20 border-b border-violet-200 dark:border-violet-800 flex items-center gap-2'>
																	<Layers className='w-3.5 h-3.5 text-violet-600 shrink-0' />
																	<p className='text-xs font-semibold text-violet-700 dark:text-violet-400'>
																		Multiple PLUs found for this
																		EAN — select the correct one
																	</p>
																</div>
																<MatchOptionsTable
																	item={item}
																	options={v.plu_options}
																	columns={[
																		'cost_price',
																		'mrp',
																		'tax_pct',
																		'priority',
																	]}
																	onSelect={(opt, tail) =>
																		selectPlu(idx, opt, tail)
																	}
																/>
															</div>
														)}

														{/* Selected PLU indicator with Change + Accept All options */}
														{canSelect && pluSel && (
															<div className='flex items-center gap-2 text-sm text-violet-700 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-800 rounded-md px-3 py-2'>
																<CheckCircle2 className='w-4 h-4 shrink-0' />
																<span>
																	Selected PLU:{' '}
																	<strong className='font-mono'>
																		{pluSel.plu_code}
																	</strong>
																</span>
																{/* "Accept all" lives under the discrepancy
                                      table below, which now covers a selection
                                      too — a second copy here acted on the same
                                      corrections. */}
																<Button
																	variant='ghost'
																	size='sm'
																	className='ml-auto h-6 text-xs text-violet-600 hover:text-violet-700'
																	onClick={(e) => {
																		e.stopPropagation();
																		clearPluSelection(idx);
																	}}>
																	Change
																</Button>
															</div>
														)}

														{/* Fuzzy match note */}
														{isFuzzy && v.match_note && (
															<div className='flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 rounded-md px-3 py-2'>
																<Info className='w-4 h-4 shrink-0 mt-0.5' />
																<span>{v.match_note}</span>
															</div>
														)}

														{/* Matched, but other records were plausible —
                                  show them with the recommendation highlighted */}
														{hasAlternatives && (
															<div
																className='border border-amber-200 dark:border-amber-800 rounded-lg overflow-hidden'
																onClick={(e) =>
																	e.stopPropagation()
																}>
																<div className='px-3 py-2 bg-amber-50 dark:bg-amber-950/20 border-b border-amber-200 dark:border-amber-800 flex items-center gap-2'>
																	<Layers className='w-3.5 h-3.5 text-amber-600 shrink-0' />
																	<p className='text-xs font-semibold text-amber-700 dark:text-amber-400'>
																		{altOptions.length} similar
																		products found — the
																		recommended match is
																		highlighted; select another
																		if it fits better
																	</p>
																</div>
																<MatchOptionsTable
																	item={item}
																	options={altOptions}
																	additionalOptions={
																		v.additional_plu_options
																	}
																	recommendedPlu={
																		v.recommended_plu ??
																		v.matched_plu
																	}
																	activePlu={
																		pluSel?.plu_code ??
																		v.matched_plu
																	}
																	onSelect={(opt, tail) =>
																		selectPlu(idx, opt, tail)
																	}
																/>
															</div>
														)}

														{/* No-match message + edit row */}
														{isNoMatch && (
															<>
																{(v.discrepancies[0]?.message ??
																	v.match_note) && (
																	<div className='flex items-start gap-2 text-sm text-muted-foreground bg-muted/40 rounded-md px-3 py-2'>
																		<AlertCircle className='w-4 h-4 shrink-0 mt-0.5' />
																		<span>
																			{v.discrepancies[0]
																				?.message ??
																				v.match_note}
																		</span>
																	</div>
																)}

																{/* Considered similar products — pickable when the
                                      EAN was not found but name-similar records exist */}
																{hasSuggestions && !pluSel && (
																	<div
																		className='border border-border rounded-lg overflow-hidden'
																		onClick={(e) =>
																			e.stopPropagation()
																		}>
																		<div className='px-3 py-2 bg-muted/50 border-b border-border flex items-center gap-2'>
																			<Layers className='w-3.5 h-3.5 text-muted-foreground shrink-0' />
																			<p className='text-xs font-semibold text-foreground'>
																				Considered{' '}
																				{
																					noMatchOptions.length
																				}{' '}
																				similar product
																				{noMatchOptions.length !==
																				1
																					? 's'
																					: ''}{' '}
																				— select the correct
																				match, or leave
																				unmatched
																			</p>
																		</div>
																		<MatchOptionsTable
																			item={item}
																			options={noMatchOptions}
																			additionalOptions={
																				v.additional_plu_options
																			}
																			columns={[
																				'ean',
																				'mrp',
																				'tax_pct',
																			]}
																			showInvoiceRow={false}
																			onSelect={(opt, tail) =>
																				selectPlu(
																					idx,
																					opt,
																					tail,
																				)
																			}
																		/>
																	</div>
																)}
															</>
														)}

														{/* Catalogue search — the way out when nothing
                                  above is the right record, or nothing was
                                  offered at all. A pick lands in selectPlu()
                                  exactly like one from the tables. */}
														{canSearch && !pluSel && (
															<div
																className='space-y-1.5'
																data-testid='catalog-search'>
																<p className='text-xs font-semibold text-foreground flex items-center gap-1.5'>
																	<Search className='w-3.5 h-3.5 text-muted-foreground' />
																	{isNoMatch && !hasSuggestions
																		? 'Search the catalogue to match this line'
																		: 'Not the right product? Search the catalogue'}
																</p>
																<CatalogSearch
																	onSelect={(opt) =>
																		selectPlu(
																			idx,
																			opt,
																			false,
																			true,
																		)
																	}
																/>
															</div>
														)}

														{/* A value worked out from the invoice's other
                                  columns that has nowhere else to appear: the
                                  invoice printed no such column, so the main
                                  table has no cell for it, and it agrees with
                                  the catalog, so no discrepancy row carries it
                                  either. Deriving a cost price and then not
                                  showing it is the one thing worse than not
                                  deriving it. */}
														{(() => {
															const unshown = Object.entries(
																derivedFields,
															).filter(
																([field]) =>
																	!fieldKeys.includes(field) &&
																	!effectiveDiscrepanciesRaw.some(
																		(d) => d.field === field,
																	),
															);
															if (!unshown.length) return null;
															return (
																<div className='flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-muted/30 px-3 py-2'>
																	{unshown.map(
																		([field, derived]) => (
																			<span
																				key={field}
																				className='inline-flex items-center gap-1.5'>
																				<span className='text-xs text-muted-foreground'>
																					{fieldLabel(
																						field,
																					)}
																				</span>
																				<span className='text-sm font-mono font-medium text-foreground'>
																					{derived.value}
																				</span>
																				<DerivedBadge
																					derived={
																						derived
																					}
																				/>
																			</span>
																		),
																	)}
																</div>
															);
														})()}

														{/* The one discrepancy table, whatever raised the
                                  finding: the backend's own comparison, or the
                                  local re-comparison against a PLU the user
                                  picked. Resolved rows are dimmed rather than
                                  removed.

                                  A multi-PLU row waiting on a choice has
                                  nothing to compare against yet, and an
                                  unmatched row states its case in the no-match
                                  notice above instead. */}
														{!isPending &&
															(!isNoMatch || hasSelection) &&
															effectiveDiscrepanciesRaw.length >
																0 && (
																<>
																	<div className='border border-border rounded-lg overflow-hidden'>
																		<Table>
																			<TableHeader>
																				<UITableRow className='bg-muted/50 hover:bg-muted/50'>
																					<TableHead className='text-xs font-semibold text-foreground'>
																						Field
																					</TableHead>
																					<TableHead className='text-xs font-semibold text-foreground'>
																						Master
																						(Expected)
																					</TableHead>
																					<TableHead className='text-xs font-semibold text-foreground'>
																						Invoice
																						Value
																					</TableHead>
																					<TableHead className='text-xs font-semibold text-foreground hidden md:table-cell'>
																						Note
																					</TableHead>
																					<TableHead className='w-32' />
																				</UITableRow>
																			</TableHeader>
																			<TableBody>
																				{effectiveDiscrepanciesRaw.map(
																					(
																						d: Discrepancy,
																						di: number,
																					) => {
																						const resolved =
																							isResolved(
																								d,
																								acceptedFields[
																									idx
																								],
																							);
																						const isDismissed =
																							dismissedFields[
																								idx
																							]?.has(
																								d.field,
																							) ??
																							false;
																						const isSuppressed =
																							suppressedFlags.has(
																								getDiscrepancyFlagType(
																									d.field,
																								),
																							);
																						const isFieldEditing =
																							editingDiscrepancy[
																								idx
																							]?.has(
																								d.field,
																							) ??
																							false;
																						// Gemini returns actual: null for
																						// a field it could not read, and
																						// a derived cost never reaches
																						// the discrepancy at all — fall
																						// back to the item so the column
																						// always shows Master vs Invoice.
																						const invoiceFallback =
																							derivedFields[
																								d
																									.field
																							]
																								?.value ??
																							d.actual ??
																							invoiceValueFor(
																								item,
																								d.field,
																							);
																						const currentVal =
																							getEditValue(
																								idx,
																								d.field,
																								invoiceFallback,
																							);
																						const derivedHere =
																							derivedFields[
																								d
																									.field
																							] ??
																							null;
																						const masterStr =
																							effectiveCorrections[
																								d
																									.field
																							] !==
																							undefined
																								? String(
																										effectiveCorrections[
																											d
																												.field
																										],
																									)
																								: null;
																						return (
																							<Fragment
																								key={
																									di
																								}>
																								<UITableRow
																									className={`hover:bg-muted/30 transition-opacity ${
																										resolved ||
																										isDismissed ||
																										isSuppressed
																											? 'opacity-50'
																											: ''
																									}`}>
																									<TableCell className='text-sm font-medium py-2'>
																										<span className='flex items-center gap-1.5'>
																											{resolved && (
																												<CheckCircle2 className='w-3.5 h-3.5 text-green-500 shrink-0' />
																											)}
																											{isDismissed &&
																												!resolved && (
																													<XCircle className='w-3.5 h-3.5 text-muted-foreground shrink-0' />
																												)}
																											{fieldLabel(
																												d.field,
																											)}
																										</span>
																									</TableCell>
																									<TableCell className='text-sm text-muted-foreground py-2 font-mono'>
																										{d.expected !==
																										null
																											? String(
																													d.expected,
																												)
																											: '—'}
																									</TableCell>
																									<TableCell
																										className='py-2'
																										onClick={(
																											e,
																										) =>
																											e.stopPropagation()
																										}>
																										{isFieldEditing ? (
																											<Input
																												className='h-7 text-sm font-mono w-28'
																												value={
																													currentVal
																												}
																												autoFocus
																												onChange={(
																													e,
																												) =>
																													setFieldEdit(
																														idx,
																														d.field,
																														e
																															.target
																															.value,
																													)
																												}
																											/>
																										) : (
																											<span className='inline-flex items-center gap-1.5'>
																												<span
																													className={`text-sm font-mono ${resolved ? 'text-green-700 dark:text-green-400 font-medium' : ''}`}>
																													{currentVal ||
																														'—'}
																												</span>
																												{derivedHere &&
																													!resolved && (
																														<DerivedBadge
																															derived={
																																derivedHere
																															}
																														/>
																													)}
																											</span>
																										)}
																									</TableCell>
																									<TableCell className='text-xs text-muted-foreground py-2 max-w-xs hidden md:table-cell'>
																										{
																											d.message
																										}
																									</TableCell>
																									<TableCell
																										className='py-2'
																										onClick={(
																											e,
																										) =>
																											e.stopPropagation()
																										}>
																										{isSuppressed &&
																										!resolved ? (
																											<Badge
																												variant='outline'
																												className='text-xs text-muted-foreground'>
																												Auto-suppressed
																											</Badge>
																										) : (
																											!resolved &&
																											(isFieldEditing ? (
																												<div className='flex gap-1'>
																													<Button
																														variant='default'
																														size='sm'
																														className='h-7 text-xs gap-1'
																														onClick={() =>
																															acceptField(
																																idx,
																																d.field,
																																currentVal,
																															)
																														}>
																														<CheckCircle2 className='w-3 h-3' />
																														Accept
																													</Button>
																													<Button
																														variant='ghost'
																														size='sm'
																														className='h-7 text-xs'
																														onClick={() =>
																															cancelFieldEdit(
																																idx,
																																d.field,
																															)
																														}>
																														Cancel
																													</Button>
																												</div>
																											) : isDismissed ? (
																												<span className='text-xs text-muted-foreground italic'>
																													Dismissed
																												</span>
																											) : (
																												<div className='flex gap-1'>
																													{masterStr !==
																														null && (
																														<Tooltip>
																															<TooltipTrigger
																																asChild>
																																<Button
																																	variant='outline'
																																	size='sm'
																																	className='h-7 text-xs gap-1'
																																	onClick={() =>
																																		acceptField(
																																			idx,
																																			d.field,
																																			masterStr,
																																		)
																																	}>
																																	<Wand2 className='w-3 h-3' />
																																	Accept
																																</Button>
																															</TooltipTrigger>
																															<TooltipContent>
																																Accept
																																master
																																value:{' '}
																																{
																																	masterStr
																																}
																															</TooltipContent>
																														</Tooltip>
																													)}
																													<Button
																														variant='ghost'
																														size='sm'
																														className='h-7 text-xs gap-1'
																														onClick={() =>
																															openFieldEdit(
																																idx,
																																d.field,
																															)
																														}>
																														<Pencil className='w-3 h-3' />
																														Edit
																													</Button>
																													<Button
																														variant='ghost'
																														size='sm'
																														className='h-7 text-xs gap-1 text-muted-foreground'
																														onClick={() =>
																															dismissField(
																																idx,
																																d.field,
																															)
																														}>
																														Dismiss
																													</Button>
																												</div>
																											))
																										)}
																									</TableCell>
																								</UITableRow>
																								{!resolved &&
																									!isDismissed &&
																									!isSuppressed &&
																									(() => {
																										const hint =
																											getHint(
																												item,
																												d.field,
																											);
																										if (
																											!hint
																										)
																											return null;
																										const displayValue =
																											isNaN(
																												Number(
																													hint.corrected_value,
																												),
																											)
																												? hint.corrected_value
																												: Number(
																														hint.corrected_value,
																													);
																										return (
																											<tr>
																												<td
																													colSpan={
																														5
																													}
																													className='px-0 pb-2 pt-0 border-0'>
																													<div className='mx-4 flex items-center gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-1.5 text-sm dark:bg-amber-950/20 dark:border-amber-800'>
																														<span className='text-amber-700 dark:text-amber-400'>
																															You've
																															corrected
																															this{' '}
																															{
																																hint.count
																															}{' '}
																															time
																															{hint.count >
																															1
																																? 's'
																																: ''}{' '}
																															before
																															{
																																' → '
																															}
																															<strong>
																																{String(
																																	displayValue,
																																)}
																															</strong>
																														</span>
																														<Button
																															size='sm'
																															variant='outline'
																															className='ml-auto h-6 border-amber-400 text-amber-800 hover:bg-amber-100 dark:border-amber-600 dark:text-amber-300 dark:hover:bg-amber-900/30'
																															onClick={(
																																e,
																															) => {
																																e.stopPropagation();
																																applyHint(
																																	idx,
																																	d.field,
																																	hint.corrected_value,
																																);
																															}}>
																															Apply
																														</Button>
																													</div>
																												</td>
																											</tr>
																										);
																									})()}
																							</Fragment>
																						);
																					},
																				)}
																			</TableBody>
																		</Table>
																	</div>

																	{/* Apply all — only shown while unresolved corrections remain */}
																	{effectiveDiscrepancies.length >
																		0 &&
																		Object.keys(
																			effectiveCorrections,
																		).length > 0 && (
																			<div className='flex justify-end'>
																				<Button
																					variant='outline'
																					size='sm'
																					className='text-xs gap-1'
																					onClick={() =>
																						applyAllSuggestions(
																							idx,
																							effectiveCorrections,
																						)
																					}>
																					<Wand2 className='w-3 h-3' />
																					Accept all
																				</Button>
																			</div>
																		)}
																</>
															)}

														{/* Inline calculation checks */}
														{(() => {
															if (
																!itemCalcResult ||
																itemCalcResult.checks.length === 0
															) {
																return null;
															}

															const failingChecks =
																itemCalcResult.checks.filter(
																	(c) => !c.ok,
																);
															const allOk =
																failingChecks.length === 0;

															return (
																<div className='border border-border rounded-lg overflow-hidden'>
																	<div className='px-3 py-2 bg-muted/50 border-b border-border flex items-center gap-2'>
																		<Calculator className='w-3.5 h-3.5 text-foreground' />
																		<p className='text-xs font-semibold text-foreground'>
																			Calculation Checks
																		</p>
																		{allOk ? (
																			<Badge className='ml-auto bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20 gap-1 text-xs'>
																				<CheckCircle2 className='w-3 h-3' />
																				All correct
																			</Badge>
																		) : (
																			<Badge className='ml-auto bg-destructive/10 text-destructive border-destructive/20 gap-1 text-xs'>
																				<XCircle className='w-3 h-3' />
																				{
																					failingChecks.length
																				}{' '}
																				issue
																				{failingChecks.length !==
																				1
																					? 's'
																					: ''}
																			</Badge>
																		)}
																	</div>

																	{allOk ? (
																		<div className='px-3 py-2 flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400'>
																			<CheckCircle2 className='w-3.5 h-3.5 shrink-0' />
																			Tax amount, cost price
																			and line amount all
																			check out.
																		</div>
																	) : (
																		<Table>
																			<TableHeader>
																				<UITableRow className='bg-muted/50 hover:bg-muted/50'>
																					<TableHead className='text-xs font-semibold text-foreground'>
																						Check
																					</TableHead>
																					<TableHead className='text-xs font-semibold text-foreground'>
																						Formula
																					</TableHead>
																					<TableHead className='text-xs font-semibold text-foreground whitespace-nowrap'>
																						Correct
																						Value
																					</TableHead>
																					<TableHead className='text-xs font-semibold text-foreground whitespace-nowrap'>
																						Invoice
																						Value
																					</TableHead>
																					<TableHead className='w-36' />
																				</UITableRow>
																			</TableHeader>
																			<TableBody>
																				{failingChecks.map(
																					(check) => (
																						<UITableRow
																							key={
																								check.field
																							}
																							className='bg-destructive/5 hover:bg-destructive/10'
																							onClick={(
																								e,
																							) =>
																								e.stopPropagation()
																							}>
																							<TableCell className='text-sm py-2 font-medium'>
																								{
																									check.label
																								}
																							</TableCell>
																							<TableCell className='text-xs text-muted-foreground py-2 font-mono whitespace-nowrap'>
																								{
																									check.formula
																								}
																							</TableCell>
																							<TableCell className='text-sm font-mono py-2 text-green-700 dark:text-green-400 font-semibold'>
																								{
																									check.calculated
																								}
																							</TableCell>
																							<TableCell className='text-sm font-mono py-2 text-destructive font-semibold'>
																								{
																									check.actual
																								}
																							</TableCell>
																							<TableCell className='py-2'>
																								{check.acceptable ===
																								false ? (
																									<span className='text-xs text-muted-foreground'>
																										Split
																										across
																										columns
																									</span>
																								) : (
																									<Tooltip>
																										<TooltipTrigger
																											asChild>
																											<Button
																												variant='outline'
																												size='sm'
																												className='h-7 text-xs gap-1'
																												onClick={() => {
																													setFieldEdit(
																														idx,
																														check.field,
																														String(
																															check.calculated,
																														),
																													);
																													setAcceptedFields(
																														(
																															prev,
																														) => ({
																															...prev,
																															[idx]: new Set(
																																[
																																	...(prev[
																																		idx
																																	] ??
																																		[]),
																																	check.field,
																																],
																															),
																														}),
																													);
																												}}>
																												<Wand2 className='w-3 h-3' />
																												Accept{' '}
																												{
																													check.calculated
																												}
																											</Button>
																										</TooltipTrigger>
																										<TooltipContent>
																											Replace{' '}
																											{
																												check.actual
																											}{' '}
																											with{' '}
																											{
																												check.calculated
																											}
																										</TooltipContent>
																									</Tooltip>
																								)}
																							</TableCell>
																						</UITableRow>
																					),
																				)}
																			</TableBody>
																		</Table>
																	)}
																</div>
															);
														})()}

														{/* Row editor — open on every row, matched or not. A clean
                                  match can still hold a mis-read value, so the
                                  fields stay editable either way. */}
														{(() => {
															// Nothing else to show in the panel means the
															// editor is the point of opening it — skip the
															// extra click and render it open.
															const editorOpen =
																editingRow.has(idx) || !hasFindings;

															if (!editorOpen) {
																return (
																	<div
																		className='flex justify-end'
																		onClick={(e) =>
																			e.stopPropagation()
																		}>
																		<Button
																			variant='outline'
																			size='sm'
																			className='h-7 text-xs gap-1'
																			onClick={(e) => {
																				e.stopPropagation();
																				setEditingRow(
																					(prev) =>
																						new Set([
																							...prev,
																							idx,
																						]),
																				);
																			}}>
																			<Pencil className='w-3 h-3' />
																			Edit Row
																		</Button>
																	</div>
																);
															}

															return (
																<div
																	className='border border-border rounded-lg overflow-hidden'
																	onClick={(e) =>
																		e.stopPropagation()
																	}>
																	<div className='px-3 py-2 bg-muted/50 border-b border-border'>
																		<p className='text-xs font-semibold text-foreground'>
																			Edit Row Values
																		</p>
																	</div>
																	<div className='p-3 grid grid-cols-2 gap-3 sm:grid-cols-3'>
																		{fieldKeys.map((key) => {
																			const currentVal =
																				edits[idx]?.[key] ??
																				String(
																					item[key] ?? '',
																				);
																			return (
																				<div
																					key={key}
																					className='space-y-1'>
																					<label className='text-xs font-medium text-muted-foreground'>
																						{fieldLabel(
																							key,
																						)}
																					</label>
																					<Input
																						className='h-7 text-sm'
																						value={
																							currentVal
																						}
																						onChange={(
																							e,
																						) =>
																							setFieldEdit(
																								idx,
																								key,
																								e
																									.target
																									.value,
																							)
																						}
																					/>
																				</div>
																			);
																		})}
																	</div>
																	<div className='px-3 py-2 border-t border-border flex gap-2 justify-end'>
																		{editingRow.has(idx) && (
																			<Button
																				variant='ghost'
																				size='sm'
																				className='h-7 text-xs'
																				onClick={() =>
																					cancelRowEdit(
																						idx,
																					)
																				}>
																				Cancel
																			</Button>
																		)}
																		<Button
																			variant='default'
																			size='sm'
																			className='h-7 text-xs gap-1'
																			onClick={() =>
																				saveRowEdits(
																					idx,
																					stillUnmatched,
																				)
																			}>
																			<CheckCircle2 className='w-3 h-3' />
																			{stillUnmatched
																				? 'Accept Row'
																				: 'Save Changes'}
																		</Button>
																	</div>
																</div>
															);
														})()}

														{/* Feedback widget — explicit preference signals */}
														<div
															className='flex items-center gap-2 pt-2 border-t border-border'
															onClick={(e) => e.stopPropagation()}>
															<span className='text-xs text-muted-foreground shrink-0'>
																Feedback:
															</span>
															<div className='flex gap-1'>
																{(
																	[
																		[
																			'feedback_too_long',
																			'Too long',
																		],
																		[
																			'feedback_too_short',
																			'Too short',
																		],
																		[
																			'feedback_too_technical',
																			'Too technical',
																		],
																		[
																			'feedback_incorrect',
																			'Incorrect',
																		],
																	] as const
																).map(([type, label]) => {
																	const flashed =
																		feedbackFlash[idx] === type;
																	return (
																		<Button
																			key={type}
																			variant='ghost'
																			size='sm'
																			className={`h-6 text-xs transition-colors ${
																				flashed
																					? 'text-green-600 dark:text-green-400'
																					: 'text-muted-foreground'
																			}`}
																			onClick={() =>
																				fireFeedback(
																					idx,
																					type,
																				)
																			}>
																			{flashed ? '✓ ' : ''}
																			{label}
																		</Button>
																	);
																})}
															</div>
														</div>

														{/* Investigation outcome */}
														{hasFindings && (
															<div
																className='flex items-center gap-2 pt-2 border-t border-border'
																onClick={(e) =>
																	e.stopPropagation()
																}>
																<span className='text-xs text-muted-foreground shrink-0'>
																	Outcome:
																</span>
																{itemOutcomes[idx] ? (
																	<Badge
																		variant='outline'
																		className='text-xs'>
																		{itemOutcomes[idx]}
																	</Badge>
																) : (
																	<div className='flex gap-1'>
																		<Button
																			variant='outline'
																			size='sm'
																			className='h-6 text-xs text-destructive border-destructive/30 hover:bg-destructive/10'
																			onClick={() =>
																				recordItemOutcome(
																					idx,
																					'Fraud',
																				)
																			}>
																			Fraud
																		</Button>
																		<Button
																			variant='outline'
																			size='sm'
																			className='h-6 text-xs text-amber-600 border-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/20'
																			onClick={() =>
																				recordItemOutcome(
																					idx,
																					'VendorError',
																				)
																			}>
																			Vendor Error
																		</Button>
																		<Button
																			variant='outline'
																			size='sm'
																			className='h-6 text-xs'
																			onClick={() =>
																				recordItemOutcome(
																					idx,
																					'FalsePositive',
																				)
																			}>
																			False Positive
																		</Button>
																	</div>
																)}
															</div>
														)}
													</div>
												</td>
											</tr>
										)}
									</Fragment>
								);
							})}
						</TableBody>
				</Table>
			</div>

			{/* Grand Total — Subtotal (computed from the line items, each on its
          own tax rate) plus the Tax printed in the invoice summary,
          reconciled against the invoice's grand total, with every step of
          the arithmetic on show. Recomputed on each edit, PLU pick and
          accepted correction. */}
			{calcResults?.grandTotalCheck &&
				(() => {
					const gt = calcResults.grandTotalCheck;
					const money = (n: number) => n.toFixed(2);
					const difference =
						gt.documentTotal === null
							? null
							: parseFloat((gt.expectedTotal - gt.documentTotal).toFixed(2));
					// Which line(s) this shortfall traces back to, so a mismatch is a
					// lead to follow rather than an unexplained number. Only the two
					// checks that feed the subtotal a line contributes are relevant
					// here — a Tax Amount or Cost Price check failing doesn't move
					// this ladder's Subtotal rung the way a wrong Taxable Value or
					// Line Amount does.
					const explainers = !gt.ok
						? calcResults.lineResults
								.flatMap((r) =>
									r.checks
										.filter(
											(c) =>
												!c.ok &&
												(c.label === 'Line Amount' ||
													c.label === 'Taxable Value'),
										)
										.map((c) => ({ idx: r.idx, check: c })),
								)
								.map(({ idx, check }) => ({
									idx,
									name: String(
										items[idx]?.['sku_description'] ??
											items[idx]?.sku_desc ??
											items[idx]?.product_name ??
											`Row ${idx + 1}`,
									),
									check,
								}))
						: [];
					const summaryParts: string[] = [];
					if (gt.printedSubtotal)
						summaryParts.push(
							`printed subtotal ${money(gt.printedSubtotal.value)} (${gt.printedSubtotal.key})`,
						);
					if (gt.taxTotal)
						summaryParts.push(
							`tax ${money(gt.taxTotal.value)} (${gt.taxTotal.keys.join(' + ')})`,
						);
					const taxableSourceLabel: Record<
						SubtotalLineContribution['taxableSource'],
						string
					> = {
						printed: 'printed',
						computed: 'rate × qty',
						back_out: 'backed out of amount',
						line_amount: 'line amount',
						none: '—',
					};
					return (
						<div className='border border-border rounded-lg overflow-hidden my-4'>
							<div className='px-3 py-2 bg-muted/50 border-b border-border flex items-center gap-3'>
								<Calculator className='w-4 h-4 text-foreground' />
								<p className='text-xs font-semibold text-foreground'>Grand Total</p>
								<span className='text-xs text-muted-foreground font-mono'>
									{gt.field ?? '—'}
								</span>
								{gt.documentTotal === null ? (
									<Badge
										variant='outline'
										className='ml-auto gap-1 text-xs text-muted-foreground'>
										<AlertCircle className='w-3 h-3' />
										No invoice total found
									</Badge>
								) : gt.ok ? (
									<Badge className='ml-auto bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20 gap-1 text-xs'>
										<CheckCircle2 className='w-3 h-3' />
										Matches invoice total
									</Badge>
								) : gt.subtotalPartial ? (
									// Some line's taxable value could not be established, so
									// the subtotal is known to be incomplete — flag it as
									// such rather than as a firm discrepancy.
									<Badge className='ml-auto bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20 gap-1 text-xs'>
										<AlertCircle className='w-3 h-3' />
										Subtotal incomplete — {gt.subtotalLinesIncluded} of{' '}
										{gt.linesTotal} lines
									</Badge>
								) : (
									<Badge className='ml-auto bg-destructive/10 text-destructive border-destructive/20 gap-1 text-xs'>
										<XCircle className='w-3 h-3' />
										Mismatch
									</Badge>
								)}
							</div>

							{/* The ladder from the computed subtotal to the invoice total. */}
							<div className='px-4 py-3 overflow-x-auto'>
								<table className='w-full text-sm'>
									<tbody>
										{gt.steps.map((st, i) => (
											<tr key={i} className='border-b border-border/50'>
												<td className='py-1.5 pr-2 w-5 font-mono text-muted-foreground'>
													{i === 0 ? '' : st.amount < 0 ? '−' : '+'}
												</td>
												<td className='py-1.5 pr-3'>
													<span>{st.label}</span>
													{st.fields.length > 0 && (
														<span className='ml-2 font-mono text-xs text-muted-foreground'>
															{st.fields.join(' + ')}
														</span>
													)}
													{st.note && (
														<span className='ml-2 text-xs text-muted-foreground'>
															({st.note})
														</span>
													)}
												</td>
												<td className='py-1.5 text-right font-mono whitespace-nowrap'>
													{money(Math.abs(st.amount))}
												</td>
											</tr>
										))}
										<tr className='border-b border-border'>
											<td className='py-1.5 pr-2 font-mono text-muted-foreground'>
												=
											</td>
											<td className='py-1.5 pr-3 font-semibold'>
												Expected grand total
											</td>
											<td className='py-1.5 text-right font-mono font-semibold whitespace-nowrap text-green-700 dark:text-green-400'>
												{money(gt.expectedTotal)}
											</td>
										</tr>
										<tr>
											<td />
											<td className='py-1.5 pr-3 font-semibold'>
												Invoice grand total
											</td>
											<td
												className={`py-1.5 text-right font-mono font-semibold whitespace-nowrap ${
													gt.documentTotal === null
														? 'text-muted-foreground'
														: gt.ok
															? ''
															: 'text-destructive'
												}`}>
												{gt.documentTotal === null
													? 'not detected'
													: money(gt.documentTotal)}
											</td>
										</tr>
										{difference !== null && !gt.ok && (
											<tr>
												<td />
												<td className='py-1.5 pr-3 font-semibold'>
													Difference
												</td>
												<td
													className={`py-1.5 text-right font-mono font-semibold whitespace-nowrap ${
														gt.subtotalPartial
															? 'text-yellow-700 dark:text-yellow-400'
															: 'text-destructive'
													}`}>
													{money(Math.abs(difference))}
												</td>
											</tr>
										)}
									</tbody>
								</table>

								{explainers.length > 0 && (
									<div className='mt-3 border border-destructive/30 bg-destructive/5 rounded-lg px-3 py-2'>
										<p className='text-xs font-semibold text-destructive flex items-center gap-1.5'>
											<Calculator className='w-3.5 h-3.5' />
											Traces to {explainers.length} line
											{explainers.length !== 1 ? 's' : ''} with a calculation mismatch
										</p>
										<ul className='mt-1.5 space-y-1'>
											{explainers.map(({ idx, name, check }, i) => (
												<li key={i}>
													<button
														type='button'
														onClick={() => goToLine(idx)}
														className='text-xs text-left text-destructive underline decoration-dotted underline-offset-2 hover:decoration-solid'>
														Line {idx + 1} ({name}) — {check.label} printed {String(check.actual)} vs expected {String(check.calculated)}
													</button>
												</li>
											))}
										</ul>
									</div>
								)}

								<div className='mt-3 space-y-1 text-xs text-muted-foreground'>
									<p>
										Subtotal computed from {gt.subtotalLinesIncluded} of{' '}
										{gt.linesTotal} line{gt.linesTotal === 1 ? '' : 's'}
										{gt.subtotalPartial &&
											`; ${gt.linesTotal - gt.subtotalLinesIncluded} line${
												gt.linesTotal - gt.subtotalLinesIncluded === 1
													? ''
													: 's'
											} had no tax fields or line amount to work from`}
										.
									</p>
									{gt.linesCounted > 0 && (
										<p>
											Printed line amounts sum to{' '}
											<span className='font-mono'>
												{money(calcResults.lineAmountSum)}
											</span>
											{gt.partial &&
												` (${gt.linesCounted} of ${gt.linesTotal} lines)`}
											{gt.documentTotal !== null &&
												(gt.lineSumOk
													? ', which matches the invoice total.'
													: ', which does not match the invoice total on its own.')}
										</p>
									)}
									{gt.coveredDiscounts.length > 0 && (
										<p>
											{gt.coveredDiscounts
												.map((d) =>
													d.covered >= d.value - GRAND_TOTAL_TOLERANCE
														? `The summary ${d.label.toLowerCase()} of ${money(d.value)} (${d.key}) is already reflected in the line taxable values, so it is not deducted again`
														: `${money(d.covered)} of the summary ${d.label.toLowerCase()} ${money(d.value)} (${d.key}) is already reflected in the line taxable values`,
												)
												.join('. ')}
											.
										</p>
									)}
									{summaryParts.length > 0 && (
										<p>
											Invoice summary cross-check: {summaryParts.join(', ')}.
										</p>
									)}
									{gt.documentTotal === null && (
										<p>
											No invoice-total field was recognised in the extracted
											document data, so there is nothing to compare against.
											Check the Extracted tab for the header the invoice
											actually uses.
										</p>
									)}
								</div>

								<Button
									variant='ghost'
									size='sm'
									className='mt-2 h-7 gap-1 text-xs text-muted-foreground hover:text-foreground'
									onClick={() => setShowTotalBreakdown((v) => !v)}>
									<ChevronDown
										className={`w-3.5 h-3.5 ${showTotalBreakdown ? 'rotate-180' : ''}`}
									/>
									{showTotalBreakdown
										? 'Hide line breakdown'
										: 'Show line breakdown'}
								</Button>

								{showTotalBreakdown && (
									<div className='mt-2 overflow-x-auto'>
										<table className='w-full text-xs'>
											<thead>
												<tr className='border-b border-border text-muted-foreground'>
													<th className='py-1 pr-2 text-left font-medium'>
														#
													</th>
													<th className='py-1 pr-2 text-left font-medium'>
														Product
													</th>
													<th className='py-1 pr-2 text-right font-medium'>
														Taxable value
													</th>
													<th className='py-1 pr-2 text-right font-medium'>
														Tax
													</th>
													<th className='py-1 pr-2 text-right font-medium'>
														Line amount
													</th>
												</tr>
											</thead>
											<tbody>
												{gt.contributions.map((c) => (
													<tr
														key={c.idx}
														className='border-b border-border/50'>
														<td className='py-1 pr-2 font-mono'>
															{c.idx + 1}
														</td>
														<td className='py-1 pr-2 max-w-[18rem] truncate'>
															{c.name}
														</td>
														<td className='py-1 pr-2 text-right font-mono whitespace-nowrap'>
															{c.taxable !== null
																? money(c.taxable)
																: '—'}
															<span className='ml-1 font-sans text-muted-foreground'>
																{
																	taxableSourceLabel[
																		c.taxableSource
																	]
																}
															</span>
														</td>
														<td className='py-1 pr-2 text-right font-mono whitespace-nowrap'>
															{c.tax !== null ? money(c.tax) : '—'}
														</td>
														<td className='py-1 pr-2 text-right font-mono whitespace-nowrap'>
															{c.lineAmount !== null
																? money(c.lineAmount)
																: '—'}
														</td>
													</tr>
												))}
												<tr>
													<td
														colSpan={2}
														className='py-1 pr-2 text-right font-semibold'>
														Subtotal
													</td>
													<td className='py-1 pr-2 text-right font-mono font-semibold whitespace-nowrap'>
														{money(gt.subtotal)}
													</td>
													<td />
													<td />
												</tr>
											</tbody>
										</table>
									</div>
								)}
							</div>
						</div>
					);
				})()}
		</TooltipProvider>
	);
};

export default ValidationResults;
