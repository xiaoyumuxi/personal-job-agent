import type { Store } from "../db.js";
import { AgentError } from "../errors.js";
import { FeishuCLI } from "./cli.js";
import { templateViews } from "./schema.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function createdBaseTarget(result: Record<string, unknown>) {
  const base = object(result.base),
    table = object(result.table);
  const baseToken = base.base_token ?? base.app_token,
    tableId = table.table_id ?? table.id;
  if (
    typeof baseToken !== "string" ||
    !baseToken ||
    typeof tableId !== "string" ||
    !tableId
  )
    throw new AgentError("PERMANENT", "FEISHU_CREATE_COORDINATES_MISSING");
  return { baseToken, tableId };
}

// Called only after explicit creation/configuration consent, under the existing runner lock.
export async function configureTemplateViews(
  store: Store,
  cli: FeishuCLI,
  checkpoint: () => Promise<unknown> = async () => {},
  step: (message: string) => void = () => {},
) {
  await checkpoint();
  await cli.check();
  if (cli.templateVersion !== 2)
    throw new AgentError(
      "PERMANENT",
      "旧版表格仍可同步；配置截图模板视图需要新版字段，请新建模板表或按文档手动调整后重试",
    );
  store.setMeta("feishuTemplateViews", null);
  const list = await cli.command("+view-list", [
    ...cli.target(),
    "--offset",
    "0",
    "--limit",
    "200",
  ]);
  if (
    !Array.isArray(list.views) ||
    list.has_more === true ||
    (typeof list.total === "number" && list.total > list.views.length)
  )
    throw new AgentError("PERMANENT", "FEISHU_VIEW_LIST_INCOMPLETE");
  const existing = list.views.map(object);
  const configured: { name: string; id: string }[] = [];
  for (const spec of templateViews) {
    await checkpoint();
    step(`配置飞书视图：${spec.name}`);
    const matches = existing.filter((view) => view.name === spec.name);
    if (matches.length > 1)
      throw new AgentError("PERMANENT", "FEISHU_DUPLICATE_TEMPLATE_VIEW");
    let view = matches[0];
    const key = `feishu:view:${cli.destination}:${spec.name}`;
    if (!view) {
      if (store.getMeta<{ state: string }>(key)?.state === "CREATING")
        throw new AgentError(
          "PERMANENT",
          "视图创建结果未知；请在飞书核查，不会重复创建。可手动补建同名视图后重新配置",
        );
      store.setMeta(key, { state: "CREATING", at: new Date().toISOString() });
      const result = await cli.command("+view-create", [
        ...cli.target(),
        "--json",
        JSON.stringify({ name: spec.name, type: spec.type }),
      ]);
      if (!Array.isArray(result.views) || result.views.length !== 1)
        throw new AgentError("PERMANENT", "FEISHU_VIEW_CREATE_RESULT_UNKNOWN");
      view = object(result.views[0]);
    }
    const id = view.id ?? view.view_id;
    if (typeof id !== "string" || !id || view.type !== spec.type)
      throw new AgentError("PERMANENT", "FEISHU_TEMPLATE_VIEW_MISMATCH");
    store.setMeta(key, { state: "CREATED", id, at: new Date().toISOString() });
    const target = [...cli.target(), "--view-id", id];
    const properties = [
      ["visible-fields", { visible_fields: spec.visible_fields }],
      ...(spec.group_config
        ? [["group", { group_config: spec.group_config }]]
        : []),
      ...(spec.sort_config
        ? [["sort", { sort_config: spec.sort_config }]]
        : []),
    ] as const;
    for (const [property, value] of properties) {
      await checkpoint();
      await cli.command(`+view-set-${property}`, [
        ...target,
        "--json",
        JSON.stringify(value),
      ]);
      // Read back the server state; a successful write response alone is not verification.
      const got = await cli.command(`+view-get-${property}`, target);
      const wrapper =
        property === "visible-fields" ? "visible_fields" : String(property);
      const body = got[wrapper];
      const propertyKey = Object.keys(value)[0]!;
      const actual = Array.isArray(body) ? body : object(body)[propertyKey];
      const fieldNames = await normalizeViewFields(cli, actual);
      if (
        JSON.stringify(fieldNames) !== JSON.stringify(Object.values(value)[0])
      )
        throw new AgentError("PERMANENT", "FEISHU_VIEW_READBACK_MISMATCH");
    }
    configured.push({ name: spec.name, id });
    store.setMeta(key, { state: "VERIFIED", id, at: new Date().toISOString() });
  }
  const result = {
    at: new Date().toISOString(),
    destination: cli.destination,
    views: configured,
  };
  store.setMeta("feishuTemplateViews", result);
  return result;
}

async function normalizeViewFields(cli: FeishuCLI, value: unknown) {
  // The API can return field IDs after accepting names. Use the checked field metadata.
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (typeof item === "string") return cli.fieldName(item);
    const group = object(item);
    return {
      field:
        typeof group.field === "string"
          ? cli.fieldName(group.field)
          : group.field,
      desc: group.desc ?? false,
    };
  });
}
