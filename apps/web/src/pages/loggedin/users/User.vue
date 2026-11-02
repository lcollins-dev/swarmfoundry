<template>
  <ui-page-container>
    <ui-page-heading v-if="user" :title="user.name" :back-to="backLink.to" :back-label="backLink.label">
      <template #leading>
        <user-avatar :user="user" size="lg" />
      </template>

      <template #tags>
        <user-access-tag :user="user" />
        <ui-tag :type="user.enabled ? 'success' : 'error'" data-testid="user-state">
          {{ user.enabled ? 'Enabled' : 'Disabled' }}
        </ui-tag>
        <ui-tag v-if="user.invited" type="warning" data-testid="user-invited">Invited</ui-tag>
      </template>

      <template #subtitle>
        <span data-testid="user-email">{{ user.email }}</span>
      </template>
    </ui-page-heading>

    <ui-back-link v-else :to="backLink.to" :label="backLink.label" />

    <template v-if="user">
      <ui-notice v-if="isSelf" type="info" title="This is your account">
        Change your name, email and password in <ui-link to="/edit-profile">Profile &amp; security</ui-link>. Ask
        another admin to change your roles or disable your account.
      </ui-notice>

      <template v-else>
        <ui-form :name="PROFILE_FORM" layout="row" @submit="doSaveProfile">
          <ui-card title="Profile" subtitle="Account details and permissions.">
            <ui-form-field v-slot="{ input }" label="Display name" help="The name shown in the app." path="name">
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
              help="Roles control access to admin features."
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
      </template>

      <ui-card title="Details">
        <ui-stat-grid :columns="2">
          <ui-stat label="Created" mono>{{ formatDayTime(user.createdDate) }}</ui-stat>
          <ui-stat label="Last active" mono>{{ formatDayTime(user.lastAccess) }}</ui-stat>
          <ui-stat label="Last sign-in" mono>{{ formatOptional(user.lastLoginSuccess) }}</ui-stat>
          <ui-stat label="Last failed sign-in" mono>{{ formatOptional(user.lastLoginFail) }}</ui-stat>
        </ui-stat-grid>
      </ui-card>

      <ui-card
        v-if="canSeeApiKeys"
        flush
        title="API keys"
        subtitle="Read-only API access for this account."
        data-testid="user-api-keys"
      >
        <api-key-table
          :api-keys="apiKeys ?? []"
          :loading="apiKeysLoading"
          :revoking-id="revokingApiKeyId"
          :empty-text="isSelf ? 'You have no API keys.' : 'This user has no API keys.'"
          @revoke="confirmRevokeApiKey"
        />
      </ui-card>

      <ui-card flush title="Access" :subtitle="ACCESS_DESCRIPTION">
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
            help="Signs this user out on all devices. They can sign in again immediately."
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

          <div>
            <ui-form-field
              v-slot="{ input }"
              layout="row"
              align="end"
              :label="user.invited ? 'Resend invite' : 'Reset password'"
              :help="linkHelp"
            >
              <ui-button
                v-bind="input"
                :disabled="isSelf || !user.enabled || blockedBy('link')"
                :loading="pending === 'link'"
                @click="doCreatePasswordLink"
              >
                {{ user.invited ? 'Resend Invite' : 'Create Reset Link' }}
              </ui-button>
            </ui-form-field>

            <password-link-notice
              v-if="passwordLink"
              class="pb-5"
              :password-link="passwordLink"
              :email="user.email"
              :invite="user.invited"
            />
          </div>
        </div>
      </ui-card>
    </template>
  </ui-page-container>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import type { ApiKeyDto, PasswordLinkDto, UpdateUserRequestDto } from '@libs/dto';
import { UserRoleId } from '@libs/dto';

import { DialogType, IDialogOptions } from '@/types/dialog';

import { useBackLink } from '@/composables/useBackLink';
import { useResource } from '@/composables/useResource';

import { formatDayTime } from '@/utils/format/date';

import { useLogService } from '@/services/LogService';
import { useApiKeyAdminService } from '@/services/api/admin/ApiKeyAdminService';
import { useUserAdminService } from '@/services/api/admin/UserAdminService';
import { useDialogStore } from '@/stores/dialog';
import { useNotificationStore } from '@/stores/notification';
import { useUserStore } from '@/stores/user';

import ApiKeyTable from '@/components/api-key/ApiKeyTable.vue';
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
import PasswordLinkNotice from '@/components/user/PasswordLinkNotice.vue';
import RoleSelect from '@/components/user/RoleSelect.vue';
import UserAccessTag from '@/components/user/UserAccessTag.vue';
import UserAvatar from '@/components/user/UserAvatar.vue';

type Action = 'profile' | 'state' | 'sessions' | 'link';

const PROFILE_FORM = 'user-profile';

const logService = useLogService();
const logger = logService.createLogger('pages/loggedin/users/User');

const route = useRoute();

const backLink = useBackLink({ to: '/users', label: 'Users' });

const dialogStore = useDialogStore();
const notificationStore = useNotificationStore();
const userStore = useUserStore();
const userAdminService = useUserAdminService();
const apiKeyAdminService = useApiKeyAdminService();

const userId = computed(() => (typeof route.params.userId === 'string' ? parseInt(route.params.userId, 10) : null));

const { data: user, reload: reloadUser } = useResource({
  request: userId,
  fetch: (targetId: number) => userAdminService.getUser(targetId),
});

// The API key endpoints admit system admins only.
const canSeeApiKeys = computed(() => userStore.hasRole(UserRoleId.SYSTEM_ADMIN));

const {
  data: apiKeys,
  loading: apiKeysLoading,
  reload: reloadApiKeys,
} = useResource({
  request: () => (canSeeApiKeys.value ? userId.value : null),
  fetch: (targetId: number) => apiKeyAdminService.getUserApiKeyList(targetId),
});

const revokingApiKeyId = ref<number | null>(null);

const name = ref('');
const email = ref('');
const roleIds = ref<number[]>([]);

const passwordLink = ref<PasswordLinkDto | null>(null);

// One action at a time, so each request is built from the user the previous one reloaded.
const pending = ref<Action | null>(null);
const loading = computed(() => pending.value !== null);

const isSelf = computed(() => user.value !== null && user.value.email === userStore.profile?.email);

const sortedJoin = (ids: number[]) => [...ids].sort((first, second) => first - second).join();

const rolesChanged = computed(
  () => user.value !== null && sortedJoin(roleIds.value) !== sortedJoin(user.value.userRoleIds)
);

const profileChanged = computed(() => {
  if (user.value === null) {
    return false;
  }

  return name.value.trim() !== user.value.name || email.value.trim() !== user.value.email || rolesChanged.value;
});

const ACCESS_DESCRIPTION = 'Manage sign-in access and password resets.';

const stateHelp = computed(() =>
  user.value?.enabled === true
    ? 'Signs this user out and blocks sign-in and API access until the account is enabled again.'
    : 'Enables sign-in and restores access for their API keys.'
);

const linkHelp = computed(() =>
  user.value?.invited === true
    ? 'Sends a new invite link and invalidates the previous one.'
    : 'Sends a password reset link. Resetting the password signs this user out on all devices.'
);

const formatOptional = (date: Date | null): string => (date === null ? 'Never' : formatDayTime(date));

const blockedBy = (action: Action) => loading.value && pending.value !== action;

const fillProfile = () => {
  name.value = user.value?.name ?? '';
  email.value = user.value?.email ?? '';
  roleIds.value = [...(user.value?.userRoleIds ?? [])];
};

// Filled once per user, so a reload after a state change keeps unsaved edits.
watch(
  () => user.value?.id,
  () => {
    fillProfile();
    passwordLink.value = null;
  },
  { immediate: true }
);

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

  const saveProfile = async () => {
    await userAdminService.updateUser(updateUserRequest, target.id, PROFILE_FORM);
    notificationStore.addToast('Profile updated');
    await reloadUser();
    fillProfile();
  };

  if (!rolesChanged.value) {
    runAction('profile', saveProfile, 'doSaveProfile(): Failed to update the profile');
    return;
  }

  // Confirmed before the request, so a refused email shows under its field rather than behind the dialog.
  dialogStore
    .confirm({
      type: DialogType.WARNING,
      title: 'Change roles?',
      message: 'This changes which admin features this user can access.',
      confirmLabel: 'Change Roles',
    })
    .then(confirmed => {
      if (confirmed) {
        runAction('profile', saveProfile, 'doSaveProfile(): Failed to update the profile');
      }
    })
    .catch((error: unknown) => {
      logger.error({ error }, 'doSaveProfile(): Failed to confirm the role change');
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
        notificationStore.addToast('Account enabled');
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
      title: 'Disable account?',
      message:
        'This user will be signed out. Sign-in and API access will be blocked until you enable the account again.',
      confirmLabel: 'Disable Account',
    },
    async () => {
      await userAdminService.updateState({ enabled: false }, target.id);
      passwordLink.value = null;
      notificationStore.addToast('Account disabled');
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
      title: 'Sign out this user?',
      message: 'This user will be signed out on all devices. They can sign in again immediately.',
      confirmLabel: 'Sign Out Everywhere',
    },
    async () => {
      await userAdminService.logoutAllSessions(target.id);
      notificationStore.addToast('Signed out everywhere');
    }
  );
};

const doCreatePasswordLink = () => {
  if (user.value === null || isSelf.value || !user.value.enabled || loading.value) {
    return;
  }

  const target = user.value;

  runAction(
    'link',
    async () => {
      passwordLink.value = await userAdminService.createPasswordLink(target.id);
      notificationStore.addToast(target.invited ? 'Invite link created' : 'Reset link created');
    },
    'doCreatePasswordLink(): Failed to create the link'
  );
};

const confirmRevokeApiKey = (apiKey: ApiKeyDto) => {
  void dialogStore.confirm({
    type: DialogType.DANGER,
    title: `Revoke ${apiKey.name}?`,
    message: 'This permanently removes access for any script or agent using this key.',
    confirmLabel: 'Revoke Key',
    action: async () => {
      revokingApiKeyId.value = apiKey.id;

      try {
        await apiKeyAdminService.revokeApiKey(apiKey.id);
        notificationStore.addToast('API key revoked');
        await reloadApiKeys();
      } finally {
        revokingApiKeyId.value = null;
      }
    },
  });
};
</script>
