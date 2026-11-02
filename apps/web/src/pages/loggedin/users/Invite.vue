<template>
  <ui-page-container>
    <ui-page-heading
      title="Invite user"
      subtitle="Send an email invitation to set up an account."
      :back-to="backLink.to"
      :back-label="backLink.label"
    />

    <ui-card v-if="invited" :title="invited.passwordLink.emailed ? 'Invite sent' : 'Invite created'">
      <password-link-notice :password-link="invited.passwordLink" :email="invitedEmail" invite />

      <template #footer>
        <div class="flex gap-2">
          <ui-button @click="doInviteAnother">Invite Another</ui-button>

          <ui-link :to="`/users/${invited.userId}`" unstyled>
            <ui-button type="primary">View User</ui-button>
          </ui-link>
        </div>
      </template>
    </ui-card>

    <ui-form v-else :name="INVITE_FORM" @submit="doInviteUser">
      <ui-card>
        <div class="mb-4">
          <div class="font-semibold text-header">Account details</div>
          <div class="text-xs text-muted">Enter the name and email of the person you want to invite.</div>
        </div>

        <ui-form-field v-slot="{ input }" label="Name" path="name">
          <ui-input v-model:value="name" v-bind="input" name="name" placeholder="Their name" :disabled="loading" />
        </ui-form-field>

        <ui-form-field v-slot="{ input }" label="Email" help="Used for the invitation and to sign in." path="email">
          <ui-input
            v-model:value="email"
            v-bind="input"
            type="email"
            name="email"
            autocomplete="off"
            placeholder="name@example.com"
            :disabled="loading"
          />
        </ui-form-field>

        <div class="mb-4 border-t border-divider pt-6">
          <div class="font-semibold text-header">Access</div>
          <div class="text-xs text-muted">You can change this at any time.</div>
        </div>

        <ui-form-field
          v-slot="{ input }"
          label="Roles"
          help="Roles control access to admin features."
          path="userRoleIds"
        >
          <role-select v-model:value="roleIds" v-bind="input" name="roles" :disabled="loading" />
        </ui-form-field>

        <template #footer>
          <div class="flex gap-2">
            <ui-link :to="backLink.to" unstyled>
              <ui-button :disabled="loading">Cancel</ui-button>
            </ui-link>

            <ui-button type="primary" native-type="submit" :loading="loading">Send Invite</ui-button>
          </div>
        </template>
      </ui-card>
    </ui-form>
  </ui-page-container>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import type { InviteUserRequestDto, InviteUserResponseDto } from '@libs/dto';

import { useBackLink } from '@/composables/useBackLink';

import { useLogService } from '@/services/LogService';
import { useUserAdminService } from '@/services/api/admin/UserAdminService';

import {
  UiButton,
  UiCard,
  UiForm,
  UiFormField,
  UiInput,
  UiLink,
  UiPageContainer,
  UiPageHeading,
} from '@/components/ui';
import PasswordLinkNotice from '@/components/user/PasswordLinkNotice.vue';
import RoleSelect from '@/components/user/RoleSelect.vue';

const INVITE_FORM = 'invite-user';

const logService = useLogService();
const logger = logService.createLogger('pages/loggedin/users/Invite');

const backLink = useBackLink({ to: '/users', label: 'Users' });

const userAdminService = useUserAdminService();

const name = ref('');
const email = ref('');
const roleIds = ref<number[]>([]);
const loading = ref(false);

const invited = ref<InviteUserResponseDto | null>(null);
const invitedEmail = ref('');

const doInviteUser = () => {
  if (loading.value) {
    return;
  }

  const inviteUserRequest: InviteUserRequestDto = {
    name: name.value.trim(),
    email: email.value.trim(),
    userRoleIds: roleIds.value,
  };

  loading.value = true;

  userAdminService
    .inviteUser(inviteUserRequest, INVITE_FORM)
    .then(response => {
      invited.value = response;
      invitedEmail.value = inviteUserRequest.email;
    })
    .finally(() => {
      loading.value = false;
    })
    .catch((error: unknown) => {
      logger.error({ error }, 'doInviteUser(): Failed to invite the user');
    });
};

const doInviteAnother = () => {
  invited.value = null;
  invitedEmail.value = '';
  name.value = '';
  email.value = '';
  roleIds.value = [];
};
</script>
