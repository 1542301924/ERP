import { ref, type Ref } from 'vue';

/**
 * 取到 Electron IPC 暴露的 window.api；浏览器预览（无 IPC）时抛出可读错误。
 */
export function api(): NonNullable<Window['api']> {
  if (!window.api) {
    throw new Error('当前未接入 Electron IPC，无法访问本地数据库');
  }
  return window.api;
}

/**
 * 通用「列表 + 新增/更新 + 删除」CRUD 组合式函数。
 * 仅封装 query(列表) / mutate(insert|update|delete)，保持最小实现，不做额外抽象。
 */
export function useCrud<T extends object = Record<string, unknown>>(
  entity: string,
  opts: { includeDeleted?: boolean } = {},
) {
  const rows = ref([]) as Ref<T[]>;
  const loading = ref(false);

  /** 读取列表（软删除过滤默认由主进程处理）。 */
  async function load(): Promise<T[]> {
    loading.value = true;
    try {
      rows.value = (await api().query(entity, { includeDeleted: opts.includeDeleted })) as unknown as T[];
      return rows.value;
    } finally {
      loading.value = false;
    }
  }

  /** 有 id 走 update（patch），否则走 insert。 */
  async function save(row: Partial<T> & { id?: string }): Promise<Record<string, unknown>> {
    const { id, ...patch } = row;
    if (id) {
      return api().mutate({ op: 'update', entity, id, patch: patch as Record<string, unknown> });
    }
    return api().mutate({ op: 'insert', entity, values: patch as Record<string, unknown> });
  }

  /** 软删除一行。 */
  async function remove(id: string): Promise<void> {
    await api().mutate({ op: 'delete', entity, id });
  }

  return { rows, loading, load, save, remove };
}
