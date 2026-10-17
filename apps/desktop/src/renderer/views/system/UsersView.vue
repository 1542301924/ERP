<script setup lang="ts">
/**
 * 用户与角色权限。
 *
 * - 用户：账号 / 姓名 / 角色 / 状态 / 口令；内置 admin 免密且不可停用删除。
 * - 角色：名称 / 备注；权限按左侧菜单勾选（未勾选任何菜单的角色默认可见全部）。
 */
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { api } from '../../composables/useCrud';
import { MENU } from '../../router';
import { useAuthStore } from '../../stores/auth';
import type { RoleRow, UserInput, UserRow } from '../../../../env';

const auth = useAuthStore();
const activeTab = ref('user');

// ---------------- 用户 ----------------
const users = ref<UserRow[]>([]);
const roles = ref<RoleRow[]>([]);
const loading = ref(false);
const userDialog = ref(false);
const saving = ref(false);
const userFormRef = ref<FormInstance>();
/** 编辑已有账号时的口令处理方式：keep 不修改 / set 设置新口令 / clear 清除（免密）。 */
const passwordAction = ref<'keep' | 'set' | 'clear'>('keep');

const userForm = reactive<{
  id: string;
  account: string;
  name: string;
  roleId: string | null;
  status: number;
  password: string;
}>({ id: '', account: '', name: '', roleId: null, status: 1, password: '' });

const userRules: FormRules = {
  account: [{ required: true, message: '请输入登录账号', trigger: 'blur' }],
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
};

// ---------------- 角色 ----------------
const roleDialog = ref(false);
const roleFormRef = ref<FormInstance>();
const roleForm = reactive<{ id: string; name: string; remark: string }>({ id: '', name: '', remark: '' });
const roleRules: FormRules = { name: [{ required: true, message: '请输入角色名称', trigger: 'blur' }] };

const permDialog = ref(false);
const permRole = ref<RoleRow | null>(null);
const permKeys = ref<string[]>([]);
const treeRef = ref<{ setCheckedKeys: (keys: string[]) => void; getCheckedKeys: (leafOnly?: boolean) => unknown[] }>();

/** 权限树：菜单分组 + 菜单项（仅菜单项会落库）。 */
const permTree = computed(() =>
  MENU.map((group) => ({
    id: `group:${group.title}`,
    label: group.title,
    children: group.items.map((item) => ({ id: item.path, label: item.title })),
  })),
);

const isBuiltinAdminRole = computed(() => permRole.value?.id === 'role_admin');

function pickMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatTime(ts: number): string {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '-';
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [u, r] = await Promise.all([api().auth.listUsers(), api().auth.listRoles()]);
    users.value = u;
    roles.value = r;
  } catch (err) {
    ElMessage.error(pickMessage(err));
  } finally {
    loading.value = false;
  }
}

// ---------------- 用户编辑 ----------------
function openUserDialog(row?: UserRow): void {
  if (row) {
    Object.assign(userForm, {
      id: row.id,
      account: row.account,
      name: row.name,
      roleId: row.role_id,
      status: row.status,
      password: '',
    });
    passwordAction.value = 'keep';
  } else {
    Object.assign(userForm, {
      id: '',
      account: '',
      name: '',
      roleId: roles.value[0]?.id ?? null,
      status: 1,
      password: '',
    });
    passwordAction.value = 'set';
  }
  userDialog.value = true;
}

async function submitUser(): Promise<void> {
  const valid = await userFormRef.value?.validate().catch(() => false);
  if (valid === false) return;

  const input: UserInput = {
    id: userForm.id || undefined,
    account: userForm.account.trim(),
    name: userForm.name.trim(),
    roleId: userForm.roleId,
    status: userForm.status,
  };
  if (!userForm.id) {
    input.password = userForm.password; // 新建：留空即免密
  } else if (passwordAction.value === 'set') {
    if (!userForm.password) {
      ElMessage.warning('请输入新口令，或选择「清除口令（免密）」');
      return;
    }
    input.password = userForm.password;
  } else if (passwordAction.value === 'clear') {
    input.password = '';
  }

  saving.value = true;
  try {
    await api().auth.saveUser(input);
    ElMessage.success('保存成功');
    userDialog.value = false;
    await load();
  } catch (err) {
    ElMessage.error(pickMessage(err));
  } finally {
    saving.value = false;
  }
}

async function removeUser(row: UserRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除账号「${row.account}」？`, '删除确认', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await api().auth.deleteUser(row.id);
    ElMessage.success('删除成功');
    await load();
  } catch (err) {
    ElMessage.error(pickMessage(err));
  }
}

// ---------------- 角色编辑 ----------------
function openRoleDialog(row?: RoleRow): void {
  Object.assign(roleForm, { id: row?.id ?? '', name: row?.name ?? '', remark: row?.remark ?? '' });
  roleDialog.value = true;
}

async function submitRole(): Promise<void> {
  const valid = await roleFormRef.value?.validate().catch(() => false);
  if (valid === false) return;
  saving.value = true;
  try {
    await api().auth.saveRole({ id: roleForm.id || undefined, name: roleForm.name.trim(), remark: roleForm.remark });
    ElMessage.success('保存成功');
    roleDialog.value = false;
    await load();
  } catch (err) {
    ElMessage.error(pickMessage(err));
  } finally {
    saving.value = false;
  }
}

async function removeRole(row: RoleRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除角色「${row.name}」？`, '删除确认', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await api().auth.deleteRole(row.id);
    ElMessage.success('删除成功');
    await load();
  } catch (err) {
    ElMessage.error(pickMessage(err));
  }
}

async function openPermissions(row: RoleRow): Promise<void> {
  permRole.value = row;
  permKeys.value = [];
  permDialog.value = true;
  try {
    const keys = await api().auth.rolePermissions(row.id);
    permKeys.value = keys;
    // 树是打开弹窗后才挂载的，需等渲染完成再回填勾选状态
    await nextTick();
    treeRef.value?.setCheckedKeys(keys);
  } catch (err) {
    ElMessage.error(pickMessage(err));
  }
}

async function submitPermissions(): Promise<void> {
  if (!permRole.value || isBuiltinAdminRole.value) return;
  const checked = (treeRef.value?.getCheckedKeys(true) ?? []) as string[];
  saving.value = true;
  try {
    await api().auth.setRolePermissions(permRole.value.id, checked.filter((k) => k.startsWith('/')));
    ElMessage.success('权限已保存');
    permDialog.value = false;
    await load();
    // 若改的是当前登录用户的角色，立即刷新侧边栏
    if (auth.user?.roleId === permRole.value.id) await auth.refreshPermissions();
  } catch (err) {
    ElMessage.error(pickMessage(err));
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <el-tabs v-model="activeTab" class="tabs">
      <!-- 用户 -->
      <el-tab-pane label="用户" name="user">
        <el-card class="card-gap">
          <el-button type="primary" @click="openUserDialog()">新增用户</el-button>
          <el-button @click="load">刷新</el-button>
          <span class="hint">内置 admin 为免密账号，不可停用或删除</span>
        </el-card>

        <el-card>
          <el-table :data="users" empty-text="暂无用户" border stripe>
            <el-table-column prop="account" label="登录账号" width="140" />
            <el-table-column prop="name" label="姓名" width="140" />
            <el-table-column label="角色" width="140">
              <template #default="{ row }">{{ row.role_name ?? '未分配' }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.status === 1 ? 'success' : 'info'" size="small">
                  {{ row.status === 1 ? '启用' : '停用' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="创建时间" min-width="180">
              <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="160" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openUserDialog(row)">编辑</el-button>
                <el-button
                  link
                  type="danger"
                  :disabled="row.id === 'user_admin'"
                  @click="removeUser(row)"
                >
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- 角色 -->
      <el-tab-pane label="角色与权限" name="role">
        <el-card class="card-gap">
          <el-button type="primary" @click="openRoleDialog()">新增角色</el-button>
          <el-button @click="load">刷新</el-button>
          <span class="hint">
            勾选菜单后该角色仅可见勾选项；一个都没勾时默认可见全部菜单（便于先建角色再收窄）
          </span>
        </el-card>

        <el-card>
          <el-table :data="roles" empty-text="暂无角色" border stripe>
            <el-table-column prop="name" label="角色名称" width="160" />
            <el-table-column label="备注" min-width="200">
              <template #default="{ row }">{{ row.remark || '-' }}</template>
            </el-table-column>
            <el-table-column prop="user_count" label="在用用户" width="110" />
            <el-table-column label="已勾选菜单" width="120">
              <template #default="{ row }">
                {{ row.id === 'role_admin' ? '全部' : row.perm_count === 0 ? '默认全部' : row.perm_count }}
              </template>
            </el-table-column>
            <el-table-column label="操作" width="240" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openPermissions(row)">权限</el-button>
                <el-button
                  link
                  type="primary"
                  :disabled="row.id === 'role_admin'"
                  @click="openRoleDialog(row)"
                >
                  编辑
                </el-button>
                <el-button
                  link
                  type="danger"
                  :disabled="row.id === 'role_admin'"
                  @click="removeRole(row)"
                >
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <!-- 用户编辑 -->
    <el-dialog v-model="userDialog" :title="userForm.id ? '编辑用户' : '新增用户'" width="460px">
      <el-form ref="userFormRef" :model="userForm" :rules="userRules" label-width="90px">
        <el-form-item label="登录账号" prop="account">
          <el-input v-model="userForm.account" placeholder="如 zhangsan" />
        </el-form-item>
        <el-form-item label="姓名" prop="name">
          <el-input v-model="userForm.name" placeholder="如 张三" />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="userForm.roleId" clearable placeholder="未分配" style="width: 100%">
            <el-option v-for="r in roles" :key="r.id" :label="r.name" :value="r.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="userForm.status" :active-value="1" :inactive-value="0" active-text="启用" />
        </el-form-item>

        <template v-if="!userForm.id">
          <el-form-item label="登录口令">
            <el-input v-model="userForm.password" type="password" show-password placeholder="留空表示免密登录" />
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="口令">
            <el-radio-group v-model="passwordAction">
              <el-radio value="keep">不修改</el-radio>
              <el-radio value="set">设置新口令</el-radio>
              <el-radio value="clear">清除（免密）</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item v-if="passwordAction === 'set'" label="新口令">
            <el-input v-model="userForm.password" type="password" show-password />
          </el-form-item>
        </template>
      </el-form>

      <template #footer>
        <el-button @click="userDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitUser">保存</el-button>
      </template>
    </el-dialog>

    <!-- 角色编辑 -->
    <el-dialog v-model="roleDialog" :title="roleForm.id ? '编辑角色' : '新增角色'" width="420px">
      <el-form ref="roleFormRef" :model="roleForm" :rules="roleRules" label-width="90px">
        <el-form-item label="角色名称" prop="name">
          <el-input v-model="roleForm.name" placeholder="如 仓管员" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="roleForm.remark" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="roleDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitRole">保存</el-button>
      </template>
    </el-dialog>

    <!-- 权限设置 -->
    <el-dialog v-model="permDialog" :title="`权限设置 — ${permRole?.name ?? ''}`" width="520px" destroy-on-close>
      <el-alert
        v-if="isBuiltinAdminRole"
        type="info"
        :closable="false"
        show-icon
        title="内置管理员角色固定拥有全部菜单权限，无需设置"
        class="alert-gap"
      />
      <el-tree
        ref="treeRef"
        :data="permTree"
        show-checkbox
        node-key="id"
        default-expand-all
        :props="{ label: 'label', children: 'children' }"
      />
      <template #footer>
        <el-button @click="permDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="isBuiltinAdminRole" @click="submitPermissions">
          保存
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.tabs {
  margin-top: -8px;
}
.alert-gap {
  margin-bottom: 12px;
}
</style>

