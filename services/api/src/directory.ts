import { UuidSchema } from "@sigongnote/contracts";
import type { FastifyInstance } from "fastify";
import { inAuthorizedTransaction } from "./auth.js";
import { ApiFault, execute, membership, principal, tenantHeader, type Services } from "./routes.js";

function uuid(value: string): string {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) throw new ApiFault("INVALID_CONTRACT");
  return parsed.data;
}

export function registerDirectoryRoutes(app: FastifyInstance, services: Services) {
  app.get("/v1/projects", async (request, reply) => execute(reply, async () => {
    const actor = await principal(request, services);
    const tenantId = tenantHeader(request);
    return inAuthorizedTransaction(services.db, actor, async tx => {
      if (await membership(tx, tenantId, actor.userId) === "viewer") throw new ApiFault("NOT_FOUND");
      const rows = await tx`select p.id,p.display_name,p.version,
        (select count(*)::int from app.work_orders w where w.tenant_id=p.tenant_id and w.project_id=p.id) as work_order_count
        from app.projects p where p.tenant_id=${tenantId}::uuid
        order by p.display_name,p.id limit 100`;
      return { status: 200, body: { projects: rows, next_cursor: null } };
    });
  }));

  app.get<{ Params: { id: string } }>("/v1/projects/:id", async (request, reply) => execute(reply, async () => {
    const actor = await principal(request, services);
    const tenantId = tenantHeader(request);
    const projectId = uuid(request.params.id);
    return inAuthorizedTransaction(services.db, actor, async tx => {
      if (await membership(tx, tenantId, actor.userId) === "viewer") throw new ApiFault("NOT_FOUND");
      const [project] = await tx`select id,display_name,version from app.projects
        where tenant_id=${tenantId}::uuid and id=${projectId}::uuid`;
      if (!project) throw new ApiFault("NOT_FOUND");
      const orders = await tx`select id,display_name,version from app.work_orders
        where tenant_id=${tenantId}::uuid and project_id=${projectId}::uuid order by created_at,id limit 100`;
      const bundles = await tx`select b.id,b.work_order_id,b.display_name,b.trade_pack_id,b.trade_pack_version,b.version
        from app.work_bundles b join app.work_orders w on
          w.tenant_id=b.tenant_id and w.id=b.work_order_id
        where w.tenant_id=${tenantId}::uuid and w.project_id=${projectId}::uuid
        order by b.created_at,b.id limit 100`;
      const documents = await tx`select e.id,e.revision_id,a.bundle_id,e.category,e.display_title,
        e.locator,e.source_kind,e.recorded_at from app.evidence_index e
        join app.evidence_attributions a on a.tenant_id=e.tenant_id and a.evidence_index_id=e.id and a.state='confirmed'
        left join app.work_bundles b on b.tenant_id=a.tenant_id and b.id=a.bundle_id
        left join app.work_orders w on w.tenant_id=b.tenant_id and w.id=b.work_order_id
        where e.tenant_id=${tenantId}::uuid and
          (a.project_id=${projectId}::uuid or w.project_id=${projectId}::uuid)
        order by e.recorded_at desc,e.id limit 100`;
      const quotes = await tx`select q.id,q.status,q.version from app.quotes q join app.work_bundles b on b.tenant_id=q.tenant_id and b.id=q.bundle_id
        join app.work_orders w on w.tenant_id=b.tenant_id and w.id=b.work_order_id where q.tenant_id=${tenantId}::uuid and w.project_id=${projectId}::uuid
        and q.status in ('approved','accepted') order by q.created_at desc limit 20`;
      const costs = await tx`select v.allocated_minor,c.status,r.tax_mode from app.current_bundle_costs v
        join app.charge_cases c on c.tenant_id=v.tenant_id and c.id=v.charge_case_id
        join app.charge_revisions r on r.tenant_id=c.tenant_id and r.id=c.current_revision_id
        join app.work_bundles b on b.tenant_id=v.tenant_id and b.id=v.bundle_id
        join app.work_orders w on w.tenant_id=b.tenant_id and w.id=b.work_order_id
        where w.tenant_id=${tenantId}::uuid and w.project_id=${projectId}::uuid`;
      const invoices = await tx`select i.id,i.direction,i.status,app.invoice_settlement_remaining(i.tenant_id,i.id) as remaining
        from app.invoices i join app.work_bundles b on b.tenant_id=i.tenant_id and b.id=i.bundle_id
        join app.work_orders w on w.tenant_id=b.tenant_id and w.id=b.work_order_id
        where i.tenant_id=${tenantId}::uuid and w.project_id=${projectId}::uuid and i.status='approved'`;
      const total = (direction:string) => {const rows=invoices.filter(x=>x.direction===direction);
        return rows.length && rows.every(x=>x.remaining!==null)?rows.reduce((sum,x)=>sum+BigInt(String(x.remaining)),0n).toString():null;};
      const cost = costs.length && costs.every(x=>x.allocated_minor!==null && x.tax_mode!=='unknown') && new Set(costs.map(x=>x.tax_mode)).size===1
        ?costs.reduce((sum,x)=>sum+BigInt(String(x.allocated_minor)),0n).toString():null;
      return { status: 200, body: { project, orders, bundles, documents, quotes,
        money: { confirmed_cost: cost, receivable: total("receivable"), payable: total("payable"), reason: "confirmed_entries_only_unknown_is_null" } } };
    });
  }));

  app.get<{ Querystring: { q?: string; project_id?: string; category?: string } }>("/v1/search",
    async (request, reply) => execute(reply, async () => {
      const actor = await principal(request, services);
      const tenantId = tenantHeader(request);
      const query = (request.query.q ?? "").normalize("NFKC").trim();
      if (query.length < 2 || query.length > 80) throw new ApiFault("INVALID_CONTRACT");
      const projectId = request.query.project_id ? uuid(request.query.project_id) : null;
      const category = request.query.category ?? null;
      if (category && !["agreement","drawing_material","delivery_work","billing_payment","inspection_defect"].includes(category))
        throw new ApiFault("INVALID_CONTRACT");
      return inAuthorizedTransaction(services.db, actor, async tx => {
        if (await membership(tx, tenantId, actor.userId) === "viewer") throw new ApiFault("NOT_FOUND");
        const rows = await tx`select e.id,e.revision_id,a.project_id,a.bundle_id,
          case when e.scope in ('company_common','product_reference') then e.scope
            when a.state='confirmed' then 'project' else 'unassigned' end as scope,e.category,
          e.display_title,e.locator,e.source_kind,e.recorded_at
          from app.evidence_index e
          left join app.evidence_attributions a on a.tenant_id=e.tenant_id and a.evidence_index_id=e.id
          left join app.work_bundles b on b.tenant_id=a.tenant_id and b.id=a.bundle_id
          left join app.work_orders w on w.tenant_id=b.tenant_id and w.id=b.work_order_id
          where e.tenant_id=${tenantId}::uuid and
            (position(lower(${query}) in lower(e.display_title))>0 or
             position(lower(${query}) in lower(e.search_text))>0) and
            (${projectId}::uuid is null or (a.state='confirmed' and
              (a.project_id=${projectId}::uuid or w.project_id=${projectId}::uuid))) and
            (${category}::text is null or e.category=${category})
          order by e.recorded_at desc,e.id limit 30`;
        return { status: 200, body: { results: rows, next_cursor: null } };
      });
    }));

  app.get<{ Params: { id: string } }>("/v1/evidence/:id", async (request, reply) => execute(reply, async () => {
    const actor = await principal(request, services);
    const tenantId = tenantHeader(request);
    const revisionId = uuid(request.params.id);
    return inAuthorizedTransaction(services.db, actor, async tx => {
      if (await membership(tx, tenantId, actor.userId) === "viewer") throw new ApiFault("NOT_FOUND");
      const [revision] = await tx`select id,document_id,revision_number,parse_state,declared_mime,created_at
        from app.document_revisions where tenant_id=${tenantId}::uuid and id=${revisionId}::uuid`;
      if (!revision) throw new ApiFault("NOT_FOUND");
      const locators = await tx`select e.id,a.project_id,a.bundle_id,
        case when e.scope in ('company_common','product_reference') then e.scope
          when a.state='confirmed' then 'project' else 'unassigned' end as scope,e.category,e.display_title,e.locator,
        e.source_kind,e.recorded_at from app.evidence_index e
        left join app.evidence_attributions a on a.tenant_id=e.tenant_id and a.evidence_index_id=e.id
        where e.tenant_id=${tenantId}::uuid and e.revision_id=${revisionId}::uuid
        order by e.recorded_at,e.id limit 100`;
      return { status: 200, body: { revision, locators, view_ticket: null } };
    });
  }));
}
