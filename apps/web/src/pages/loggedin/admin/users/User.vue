<template>
  <ui-page-container>
    <ui-page-heading v-if="user" :title="user.name" back-to="/admin/users" back-label="Users">
      <template #leading>
        <user-avatar :user="user" size="lg" />
      </template>

      <template #subtitle>
        <span data-testid="user-email">{{ user.email }}</span>
      </template>

      <div class="flex gap-1.5">
        <user-access-tag :user="user" />
        <ui-tag :type="user.enabled ? 'success' : 'error'" data-testid="user-state">
          {{ user.enabled ? 'Enabled' : 'Disabled' }}
        </ui-tag>
      </div>
    </ui-page-heading>

    <ui-back-link v-else to="/admin/users" label="Users" />

    <template v-if="user">
      <ui-notice v-if="isSelf" type="info" title="This is your account">
        Change your name, email and password in <ui-link to="/edit-profile">Profile &amp; security</ui-link>. Another
        admin has to change your roles or disable your account.
      </ui-notice>

      <template v-else>
        <ui-form :name="PROFILE_FORM" layout="row" @submit="doSaveProfile">
          <ui-card title="Profile" subtitle="Who they are and what they can do.">
            <ui-form-field v-slot="{ input }" label="Display name" help="Shown in their header." path="name">
              <ui-input
                v-model:value="name"
                v-bind="input"
                name="display-name"
                placeholder="Their name"
                :disabled="pending === 'profile'"
              />
            </ui-form-field>

            <ui-form-field v-slot="{ input }" label="Email" help="Used to sign in." path="email">
              <ui-input
                v-model:value="email"
                v-bind="input"
                type="email"
                name="email"
                autocomplete="off"
                :disabled="pending === 'profile'"
              />
            </ui-form-field>

            <ui-form-field
              v-slot="{ input }"
              label="Roles"
              help="Each role opens an admin area to them."
              path="userRoleIds"
            >
              <role-select v-model:value="roleIds" v-bind="input" name="roles" :disabled="pending === 'profile'" />
            </ui-form-field>

            <template #footer>
              <ui-button
                type="primary"
                native-type="submit"
                :disabled="!profileChanged || blockedBy('profile')"
                :loading="pending === 'profile'"
              >
                Save
              </ui-button>
            </template>
          </ui-card>
        </ui-form>

        <ui-form :name="PASSWORD_FORM" layout="row" @submit="doSetPassword">
          <ui-card title="Password" subtitle="Setting a new one signs them out everywhere.">
            <ui-form-field v-slot="{ input }" label="New password" path="password">
              <ui-input
                v-model:value="newPassword"
                v-bind="input"
                type="password"
                name="new-password"
                autocomplete="new-password"
                placeholder="New password"
                :disabled="pending === 'password'"
              />
            </ui-form-field>

            <ui-form-field v-slot="{ input }" label="Confirm new password" path="confirmPassword">
              <ui-input
                v-model:value="confirmPassword"
                v-bind="input"
                type="password"
                name="confirm-password"
                autocomplete="new-password"
                placeholder="Enter it again"
                :disabled="pending === 'password'"
              />
            </ui-form-field>

            <template #footer>
              <ui-button
                type="primary"
                native-type="submit"
                :disabled="blockedBy('password')"
                :loading="pending === 'password'"
              >
                Set Password
              </ui-button>
            </template>
          </ui-card>
        </ui-form>
      </template>

      <ui-card title="Details">
        <ui-stat-grid :columns="2">
          <ui-stat label="Created" mono>{{ formatDayTime(user.createdDate) }}</ui-stat>
          <ui-stat label="Last active" mono>{{ formatDayTime(user.lastAccess) }}</ui-stat>
          <ui-stat label="Last sign-in" mono>{{ formatOptional(user.lastLoginSuccess) }}</ui-stat>
          <ui-stat label="Last failed sign-in" mono>{{ formatOptional(user.lastLoginFail) }}</ui-stat>
        </ui-stat-grid>
      </ui-card>

      <ui-card flush title="Access" :subtitle="accessDescription">
        <div class="divide-y divide-divider px-6">
          <ui-form-field
            v-slot="{ input }"
            layout="row"
            align="end"
            :label="user.enabled ? 'Disable account' : 'Enable account'"
            :help="stateHelp"
          >
            <ui-button
              v-bind="input"
              :disabled="isSelf || blockedBy('state')"
              :loading="pending === 'state'"
              @click="doToggleEnabled"
            >
              {{ user.enabled ? 'Disable' : 'Enable' }}
            </ui-button>
          </ui-form-field>

          <ui-form-field
            v-slot="{ input }"
            layout="row"
            align="end"
            label="Sign out everywhere"
            help="Ends every session they have. They can sign in again straight away."
          >
            <ui-button
              v-bind="input"
              :disabled="isSelf || blockedBy('sessions')"
              :loading="pending === 'sessions'"
              @click="doSignOutEverywhere"
            >
              Sign Out
            </ui-button>
          </ui-form-field>
        </div>
      </ui-card>
    </template>
  </ui-page-container>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import type { UpdateUserRequestDto } from '@libs/dto';

import { DialogType, IDialogOptions } from '@/types/dialog';

import { useResource } from '@/composables/useResource';

import { formatDayTime } from '@/utils/format/date';
import { passwordMismatchError } from '@/utils/password';

import { useLogService } from '@/services/LogService';
import { useUserAdminService } from '@/services/api/admin/UserAdminService';
import { useDialogStore } from '@/stores/dialog';
import { useErrorStore } from '@/stores/error';
import { useNotificationStore } from '@/stores/notification';
import { useUserStore } from '@/stores/user';

import {
  UiBackLink,
  UiButton,
  UiCard,
  UiForm,
  UiFormField,
  UiInput,
  UiLink,
  UiNotice,
  UiPageContainer,
  UiPageHeading,
  UiStat,
  UiStatGrid,
  UiTag,
} from '@/components/ui';
import RoleSelect from '@/components/user/RoleSelect.vue';
import UserAccessTag from '@/components/user/UserAccessTag.vue';
import UserAvatar from '@/components/user/UserAvatar.vue';

type Action = 'profile' | 'password' | 'state' | 'sessions';

const PROFILE_FORM = 'user-profile';
const PASSWORD_FORM = 'user-password';

const logService = useLogService();
const logger = logService.createLogger('pages/loggedin/admin/users/User');

const route = useRoute();

const dialogStore = useDialogStore();
const errorStore = useErrorStore();
const notificationStore = useNotificationStore();
const userStore = useUserStore();
const userAdminService = useUserAdminService();

const userId = computed(() => (typeof route.params.userId === 'string' ? parseInt(route.params.userId, 10) : null));

const { data: user, reload: reloadUser } = useResource({
  request: userId,
  fetch: (targetId: number) => userAdminService.getUser(targetId),
});

const name = ref('');
const email = ref('');
const roleIds = ref<number[]>([]);

const newPassword = ref('');
const confirmPassword = ref('');

// One action at a time, so each request is built from the user the previous one reloaded.
const pending = ref<Action | null>(null);
const loading = computed(() => pending.value !== null);

const isSelf = computed(() => user.value !== null && user.value.email === userStore.profile?.email);

const profileChanged = computed(() => {
  if (user.value === null) {
    return false;
  }

  const sortedJoin = (ids: number[]) => [...ids].sort((first, second) => first - second).join();

  return (
    name.value.trim() !== user.value.name ||
    email.value.trim() !== user.value.email ||
    sortedJoin(roleIds.value) !== sortedJoin(user.value.userRoleIds)
  );
});

const accessDescription = computed(() =>
  isSelf.value ? "You can't change your own access." : 'Whether they can sign in.'
);

const stateHelp = computed(() =>
  user.value?.enabled === true
    ? 'Signs them out everywhere and stops them signing in. You can enable them again later.'
    : "They can't sign in. Enable the account to let them back in."
);

const formatOptional = (date: Date | null): string => (date === null ? 'Never' : formatDayTime(date));

const blockedBy = (action: Action) => loading.value && pending.value !== action;

const fillProfile = () => {
  name.value = user.value?.name ?? '';
  email.value = user.value?.email ?? '';
  roleIds.value = [...(user.value?.userRoleIds ?? [])];
};

// Filled once per user, so a reload after a state change keeps unsaved edits.
watch(() => user.value?.id, fillProfile, { immediate: true });

const runAction = (action: Action, request: () => Promise<void>, failure: string) => {
  pending.value = action;

  request()
    .finally(() => {
      pending.value = null;
    })
    .catch((error: unknown) => {
      logger.error({ error }, failure);
    });
};

// The dialog's action holds the one pending action, so the page's other buttons wait for it.
const confirmAction = (action: Action, options: Omit<IDialogOptions, 'action'>, request: () => Promise<void>) => {
  void dialogStore.confirm({
    ...options,
    action: async () => {
      pending.value = action;

      try {
        await request();
      } finally {
        pending.value = null;
      }
    },
  });
};

const doSaveProfile = () => {
  if (user.value === null || isSelf.value || loading.value || !profileChanged.value) {
    return;
  }

  const target = user.value;
  const updateUserRequest: UpdateUserRequestDto = {
    name: name.value.trim(),
    email: email.value.trim(),
    userRoleIds: roleIds.value,
  };

  runAction(
    'profile',
    async () => {
      await userAdminService.updateUser(updateUserRequest, target.id, PROFILE_FORM);
      notificationStore.addToast('Profile updated', 'Their changes have been saved.');
      await reloadUser();
      fillProfile();
    },
    'doSaveProfile(): Failed to update the profile'
  );
};

const doSetPassword = () => {
  if (user.value === null || isSelf.value || loading.value) {
    return;
  }

  if (newPassword.value !== confirmPassword.value) {
    errorStore.setValidationError(passwordMismatchError(PASSWORD_FORM));
    return;
  }

  // A request clears the last refusal, but the confirm dialog shows before it.
  errorStore.clearValidationError();

  const target = user.value;
  const updateUserRequest: UpdateUserRequestDto = {
    name: target.name,
    email: target.email,
    userRoleIds: target.userRoleIds,
    password: newPassword.value,
  };

  // Confirmed before the request, so a refused password shows under its field rather than behind the dialog.
  dialogStore
    .confirm({
      type: DialogType.WARNING,
      title: `Set a new password for ${target.name}?`,
      message: "Their current password stops working, and they're signed out everywhere.",
      confirmLabel: 'Set Password',
    })
    .then(confirmed => {
      if (!confirmed) {
        return;
      }

      runAction(
        'password',
        async () => {
          await userAdminService.updateUser(updateUserRequest, target.id, PASSWORD_FORM);
          newPassword.value = '';
          confirmPassword.value = '';
          notificationStore.addToast('Password set', `${target.name} signs in with the new password from now on.`);
        },
        'doSetPassword(): Failed to set the password'
      );
    })
    .catch((error: unknown) => {
      logger.error({ error }, 'doSetPassword(): Failed to confirm the password');
    });
};

const doToggleEnabled = () => {
  if (user.value === null || isSelf.value || loading.value) {
    return;
  }

  const target = user.value;

  if (!target.enabled) {
    runAction(
      'state',
      async () => {
        await userAdminService.updateState({ enabled: true }, target.id);
        notificationStore.addToast('Account enabled', `${target.name} can sign in again.`);
        await reloadUser();
      },
      'doToggleEnabled(): Failed to enable the account'
    );
    return;
  }

  confirmAction(
    'state',
    {
      type: DialogType.WARNING,
      title: `Disable ${target.name}?`,
      message: "They're signed out everywhere and can't sign in until you enable the account again.",
      confirmLabel: 'Disable Account',
    },
    async () => {
      await userAdminService.updateState({ enabled: false }, target.id);
      notificationStore.addToast('Account disabled', `${target.name} has been signed out everywhere.`);
      await reloadUser();
    }
  );
};

const doSignOutEverywhere = () => {
  if (user.value === null || isSelf.value || loading.value) {
    return;
  }

  const target = user.value;

  confirmAction(
    'sessions',
    {
      type: DialogType.WARNING,
      title: `Sign ${target.name} out everywhere?`,
      message: 'Every session they have ends. They can sign in again straight away.',
      confirmLabel: 'Sign Out Everywhere',
    },
    async () => {
      await userAdminService.logoutAllSessions(target.id);
      notificationStore.addToast('Signed out everywhere', `${target.name} has to sign in again.`);
    }
  );
};
</script>
