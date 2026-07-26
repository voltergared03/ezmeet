import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireOrg } from '@/lib/api-auth';
import { withRoute } from '@/lib/with-route';
import { jsonError, jsonOk } from '@/lib/http';
import { rowForOrg, basePermission, atLeast, gate, stripHidden } from '@/lib/base-engine';
import { mergeRowData, presentRowData } from '@/lib/base-rows';
import { enrichLinks } from '@/lib/base-links';
import { syncRowReverseLinks } from '@/lib/base-link-sync';

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    data: z.record(z.string(), z.unknown()).optional(),
    position: z.number().int().optional(),
  })
  .strict();

// PATCH — partial cell update (editor+). Hidden fields can't be written.
export const PATCH = withRoute('rows.update', async (req: NextRequest, ctx: Ctx) => {
  const r = await requireOrg();
  if (r instanceof Response) return r;
  const { id } = await ctx.params;
  const row = await rowForOrg(id, r.orgId, r.session);
  if (!row) return jsonError('not_found', 404);
  const perm = await basePermission(row.table.base, r.orgId, r.session);
  if (!atLeast(perm.level, 'editor')) return jsonError('forbidden', 403);
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonError('invalid_body', 400);

  const fields = await prisma.field.findMany({ where: { tableId: row.tableId }, select: { id: true, type: true, options: true } });
  const patch = parsed.data.data !== undefined
    ? stripHidden(parsed.data.data as Record<string, unknown>, perm.hiddenFields)
    : undefined;

  // Merge under a row lock. `data` is one JSON blob keyed by field id, so a plain
  // read-here / merge-in-JS / write-whole-blob loses a concurrent edit to a DIFFERENT cell
  // (both read the same snapshot, the second write clobbers the first). SELECT … FOR UPDATE
  // serialises writers on this row, so each merge runs against the freshest committed data.
  const { updated, before } = await prisma.$transaction(async (tx) => {
    const fieldsToSet: Prisma.RowUpdateInput = {};
    if (parsed.data.position !== undefined) fieldsToSet.position = parsed.data.position;
    let cur: Record<string, unknown> = (row.data ?? {}) as Record<string, unknown>;
    if (patch !== undefined) {
      const locked = await tx.$queryRaw<{ data: unknown }[]>(
        Prisma.sql`SELECT data FROM "Row" WHERE id = ${id} FOR UPDATE`,
      );
      cur = (locked[0]?.data ?? {}) as Record<string, unknown>;
      fieldsToSet.data = mergeRowData(fields, cur, patch);
    }
    const u = await tx.row.update({ where: { id }, data: fieldsToSet });
    return { updated: u, before: cur };
  });
  if (patch !== undefined) {
    await syncRowReverseLinks(fields, id, before, (updated.data ?? {}) as Record<string, unknown>);
  }
  const [enriched] = await enrichLinks([{ ...updated, data: presentRowData((updated.data ?? {}) as Record<string, unknown>, fields) }], fields, r.orgId, r.session);
  return NextResponse.json(enriched);
});

// DELETE — editor+.
export const DELETE = withRoute('rows.delete', async (_req: NextRequest, ctx: Ctx) => {
  const r = await requireOrg();
  if (r instanceof Response) return r;
  const { id } = await ctx.params;
  const row = await rowForOrg(id, r.orgId, r.session);
  if (!row) return jsonError('not_found', 404);
  const g = await gate(row.table.base, r.orgId, r.session, 'editor');
  if (g) return g;
  const fields = await prisma.field.findMany({ where: { tableId: row.tableId }, select: { id: true, type: true, options: true } });
  await syncRowReverseLinks(fields, id, (row.data ?? {}) as Record<string, unknown>, {});
  await prisma.row.delete({ where: { id } });
  return jsonOk();
});
