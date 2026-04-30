#!/usr/bin/env python3
"""External reconciliation check — verifies all allocation data integrity."""

import subprocess

def psql(q):
    r = subprocess.run(
        ['docker','compose','exec','-T','postgres','psql',
         '-U','bg_tracker','-d','bg_tracker',
         '--pset=pager=off','--pset=tuples_only=on',
         '--pset=format=unaligned','--pset=fieldsep=|','-c',q],
        capture_output=True, text=True, cwd='/home/mwsl/business/bg-tracker'
    )
    rows = [line.split('|') for line in r.stdout.strip().split('\n') if line.strip()]
    return rows

errors = []
warnings = []

# CHECK 1: Duplicate allocations (same purchase+receipt)
print('CHECK 1: Duplicate allocations (same purchase_id + receipt_id)...')
dups = psql('''
SELECT purchase_id, receipt_id, COUNT(*) as cnt
FROM purchase_allocations
GROUP BY purchase_id, receipt_id
HAVING COUNT(*) > 1
''')
if dups and dups[0][0]:
    for d in dups:
        errors.append(f'  DUP: purchase={d[0]} receipt={d[1]} count={d[2]}')
else:
    print('  OK -- no duplicates')

# CHECK 2: Over-allocated purchases (allocated > |quantity|)
print('CHECK 2: Over-allocated purchases...')
over_purchase = psql('''
SELECT p.id, i.name, p.quantity, COALESCE(SUM(pa.allocated_qty),0) as alloc
FROM purchases p
JOIN items i ON i.id = p.item_id
LEFT JOIN purchase_allocations pa ON pa.purchase_id = p.id
GROUP BY p.id, i.name, p.quantity
HAVING COALESCE(SUM(pa.allocated_qty),0) > ABS(p.quantity)
''')
if over_purchase and over_purchase[0][0]:
    for r in over_purchase:
        errors.append(f'  OVER-ALLOC purchase: {r[0]} ({r[1]}) qty={r[2]} allocated={r[3]}')
else:
    print('  OK -- no over-allocated purchases')

# CHECK 3: Over-allocated receipt lines (allocated > line qty)
print('CHECK 3: Over-allocated receipt lines...')
over_line = psql('''
SELECT rli.id, i.name, rli.quantity, rli.state, COALESCE(SUM(pa.allocated_qty),0) as alloc,
       r.receipt_number
FROM receipt_line_items rli
JOIN items i ON i.id = rli.item_id
JOIN receipts r ON r.id = rli.receipt_id
LEFT JOIN purchase_allocations pa ON pa.receipt_line_item_id = rli.id
GROUP BY rli.id, i.name, rli.quantity, rli.state, r.receipt_number
HAVING COALESCE(SUM(pa.allocated_qty),0) > rli.quantity
''')
if over_line and over_line[0][0]:
    for r in over_line:
        errors.append(f'  OVER-ALLOC line: {r[5]} {r[1]} state={r[3]} qty={r[2]} allocated={r[4]}')
else:
    print('  OK -- no over-allocated receipt lines')

# CHECK 4: Cross-item allocations
print('CHECK 4: Cross-item allocation mismatches...')
cross = psql('''
SELECT pa.id, pi.name as purchase_item, ri.name as receipt_item, r.receipt_number
FROM purchase_allocations pa
JOIN purchases p ON p.id = pa.purchase_id
JOIN items pi ON pi.id = p.item_id
JOIN receipt_line_items rli ON rli.id = pa.receipt_line_item_id
JOIN items ri ON ri.id = rli.item_id
JOIN receipts r ON r.id = pa.receipt_id
WHERE p.item_id != rli.item_id
''')
if cross and cross[0][0]:
    for r in cross:
        errors.append(f'  CROSS-ITEM: alloc={r[0]} purchase_item={r[1]} receipt_item={r[2]} receipt={r[3]}')
else:
    print('  OK -- no cross-item mismatches')

# CHECK 5: Sale purchases allocated to non-active lines
print('CHECK 5: Sale purchases allocated to non-active receipt lines...')
bad_state_sale = psql('''
SELECT pa.id, p.id as purchase_id, i.name, rli.state, r.receipt_number
FROM purchase_allocations pa
JOIN purchases p ON p.id = pa.purchase_id
JOIN items i ON i.id = p.item_id
JOIN receipt_line_items rli ON rli.id = pa.receipt_line_item_id
JOIN receipts r ON r.id = pa.receipt_id
WHERE p.quantity > 0 AND p.purchase_type != 'refund'
  AND rli.state != 'active'
''')
if bad_state_sale and bad_state_sale[0][0]:
    for r in bad_state_sale:
        errors.append(f'  WRONG-STATE: sale purchase {r[1]} ({r[2]}) -> {r[3]} line on {r[4]}')
else:
    print('  OK -- all sale allocations point to active lines')

# CHECK 6: Refund purchases allocated to non-returned lines
print('CHECK 6: Refund purchases allocated to non-returned receipt lines...')
bad_state_refund = psql('''
SELECT pa.id, p.id as purchase_id, i.name, rli.state, r.receipt_number
FROM purchase_allocations pa
JOIN purchases p ON p.id = pa.purchase_id
JOIN items i ON i.id = p.item_id
JOIN receipt_line_items rli ON rli.id = pa.receipt_line_item_id
JOIN receipts r ON r.id = pa.receipt_id
WHERE (p.purchase_type = 'refund' OR p.quantity < 0)
  AND rli.state != 'returned'
''')
if bad_state_refund and bad_state_refund[0][0]:
    for r in bad_state_refund:
        warnings.append(f'  REFUND->NON-RETURNED: purchase {r[1]} ({r[2]}) -> {r[3]} line on {r[4]}')
else:
    print('  OK -- all refund allocations point to returned lines')

# CHECK 7: Orphan allocations
print('CHECK 7: Orphan allocations...')
orphans = psql('''
SELECT pa.id,
  CASE WHEN p.id IS NULL THEN 'missing_purchase' ELSE '' END,
  CASE WHEN r.id IS NULL THEN 'missing_receipt' ELSE '' END,
  CASE WHEN rli.id IS NULL AND pa.receipt_line_item_id IS NOT NULL THEN 'missing_line' ELSE '' END
FROM purchase_allocations pa
LEFT JOIN purchases p ON p.id = pa.purchase_id
LEFT JOIN receipts r ON r.id = pa.receipt_id
LEFT JOIN receipt_line_items rli ON rli.id = pa.receipt_line_item_id
WHERE p.id IS NULL OR r.id IS NULL OR (pa.receipt_line_item_id IS NOT NULL AND rli.id IS NULL)
''')
if orphans and orphans[0][0]:
    for r in orphans:
        errors.append(f'  ORPHAN: alloc={r[0]} {r[1]} {r[2]} {r[3]}')
else:
    print('  OK -- no orphan allocations')

# CHECK 8: Per-item supply/demand balance
print('CHECK 8: Per-item supply vs demand balance...')
balance = psql('''
WITH supply AS (
  SELECT rli.item_id, i.name,
    SUM(CASE WHEN rli.state = 'active' THEN rli.quantity ELSE 0 END) as active_qty,
    SUM(CASE WHEN rli.state = 'returned' THEN rli.quantity ELSE 0 END) as returned_qty
  FROM receipt_line_items rli
  JOIN items i ON i.id = rli.item_id
  WHERE rli.line_type = 'item' AND rli.parent_line_item_id IS NULL
  GROUP BY rli.item_id, i.name
),
demand AS (
  SELECT p.item_id,
    SUM(CASE WHEN p.quantity > 0 AND p.purchase_type NOT IN ('bonus','refund') THEN p.quantity ELSE 0 END) as sold_qty,
    SUM(CASE WHEN p.purchase_type = 'refund' OR p.quantity < 0 THEN ABS(p.quantity) ELSE 0 END) as refund_qty,
    SUM(CASE WHEN p.purchase_type = 'bonus' THEN p.quantity ELSE 0 END) as bonus_qty
  FROM purchases p
  GROUP BY p.item_id
)
SELECT s.name, s.active_qty, s.returned_qty,
       COALESCE(d.sold_qty,0) as sold,
       COALESCE(d.refund_qty,0) as refund,
       COALESCE(d.bonus_qty,0) as bonus,
       s.active_qty - COALESCE(d.sold_qty,0) as active_surplus,
       s.returned_qty - COALESCE(d.refund_qty,0) as returned_surplus
FROM supply s
LEFT JOIN demand d ON d.item_id = s.item_id
ORDER BY s.name
''')
sep = '-'
print(f'  {"Item":<35} {"Active":>6} {"Sold":>6} {"A-Surp":>7} {"Ret":>5} {"Refnd":>6} {"R-Surp":>7}')
print(f'  {sep*35} {sep*6} {sep*6} {sep*7} {sep*5} {sep*6} {sep*7}')
for r in balance:
    if not r[0]: continue
    name = r[0]
    active, ret, sold, refund, bonus = int(r[1]), int(r[2]), int(r[3]), int(r[4]), int(r[5])
    a_surplus, r_surplus = int(r[6]), int(r[7])
    flag_a = ' !!' if a_surplus != 0 else ''
    flag_r = ' !!' if r_surplus != 0 else ''
    print(f'  {name:<35} {active:>6} {sold:>6} {a_surplus:>+7}{flag_a} {ret:>5} {refund:>6} {r_surplus:>+7}{flag_r}')
    if a_surplus != 0:
        warnings.append(f'  ACTIVE SURPLUS: {name} has {a_surplus:+d} (active={active} sold={sold})')
    if r_surplus != 0:
        warnings.append(f'  RETURNED SURPLUS: {name} has {r_surplus:+d} (returned={ret} refunded={refund})')

# CHECK 9: Negative or zero allocations
print('CHECK 9: Negative or zero allocations...')
bad_alloc = psql('''
SELECT pa.id, pa.allocated_qty, p.id as purchase_id, i.name
FROM purchase_allocations pa
JOIN purchases p ON p.id = pa.purchase_id
JOIN items i ON i.id = p.item_id
WHERE pa.allocated_qty <= 0
''')
if bad_alloc and bad_alloc[0][0]:
    for r in bad_alloc:
        errors.append(f'  BAD-QTY: alloc={r[0]} qty={r[1]} purchase={r[2]} ({r[3]})')
else:
    print('  OK -- all allocation quantities are positive')

# CHECK 10: Duplicate receipt lines
print('CHECK 10: Duplicate receipt lines (same receipt+item+state)...')
dup_lines = psql("""
SELECT r.receipt_number, i.name, rli.state, COUNT(*),
       STRING_AGG(rli.quantity::text, ',' ORDER BY rli.id) as qtys
FROM receipt_line_items rli
JOIN receipts r ON r.id = rli.receipt_id
JOIN items i ON i.id = rli.item_id
WHERE rli.line_type = 'item' AND rli.parent_line_item_id IS NULL
GROUP BY r.receipt_number, rli.item_id, i.name, rli.state
HAVING COUNT(*) > 1
""")
if dup_lines and dup_lines[0][0]:
    for r in dup_lines:
        warnings.append(f'  DUP-LINES: {r[0]} {r[1]} state={r[2]} count={r[3]} qtys=[{r[4]}]')
else:
    print('  OK -- no duplicate receipt lines')

# CHECK 11: Allocations to adjustment/child lines
print('CHECK 11: Allocations to adjustment or child lines...')
adj_allocs = psql('''
SELECT pa.id, rli.line_type, rli.parent_line_item_id IS NOT NULL as is_child, r.receipt_number
FROM purchase_allocations pa
JOIN receipt_line_items rli ON rli.id = pa.receipt_line_item_id
JOIN receipts r ON r.id = pa.receipt_id
WHERE rli.line_type != 'item' OR rli.parent_line_item_id IS NOT NULL
''')
if adj_allocs and adj_allocs[0][0]:
    for r in adj_allocs:
        errors.append(f'  ADJ-ALLOC: alloc={r[0]} type={r[1]} is_child={r[2]} receipt={r[3]}')
else:
    print('  OK -- no allocations to adjustment/child lines')

# SUMMARY
print()
print('=' * 60)
if errors:
    print(f'ERRORS ({len(errors)}):')
    for e in errors:
        print(e)
else:
    print('NO ERRORS')

if warnings:
    print(f'WARNINGS ({len(warnings)}):')
    for w in warnings:
        print(w)
else:
    print('NO WARNINGS')

total_allocs = psql('SELECT COUNT(*) FROM purchase_allocations')
total_purchases = psql('SELECT COUNT(*) FROM purchases')
total_lines = psql("""SELECT COUNT(*) FROM receipt_line_items WHERE line_type='item' AND parent_line_item_id IS NULL""")
print()
print(f'Total allocations: {total_allocs[0][0].strip()}')
print(f'Total purchases: {total_purchases[0][0].strip()}')
print(f'Total receipt lines: {total_lines[0][0].strip()}')
print('=' * 60)
