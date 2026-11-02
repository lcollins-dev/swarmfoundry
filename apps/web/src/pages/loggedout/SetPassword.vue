<template>
  <ui-card class="mx-auto mt-10 max-w-sm">
    <ui-form
      v-if="state === PasswordLinkState.VALID && passwordLink"
      :name="FORM_NAME"
      data-testid="set-password-form"
      @submit="doSetPassword"
    >
      <ui-form-heading
        :title="passwordLink.invite ? 'Choose your password' : 'Reset your password'"
        :subtitle="
          passwordLink.invite
            ? `Welcome to ${Config.APP_NAME}, ${passwordLink.name}. Choose a password to sign in.`
            : 'Choose a new password. This signs you out on other devices.'
        "
      />

      <ui-form-field v-slot="{ input }" label="Email">
        <ui-input :value="passwordLink.email" v-bind="input" name="email" autocomplete="username" readonly />
      </ui-form-field>

      <ui-form-field v-slot="{ input }" label="New password" path="password">
        <ui-input
          v-model:value="password"
          v-bind="input"
          type="password"
          name="new-password"
          autocomplete="new-password"
          placeholder="Choose a password"
          :disabled="loading"
        />
      </ui-form-field>

      <ui-form-field v-slot="{ input }" label="Confirm password" path="confirmPassword">
        <ui-input
          v-model:value="confirmPassword"
          v-bind="input"
          type="password"
          name="confirm-password"
          autocomplete="new-password"
          placeholder="Enter it again"
          :disabled="loading"
        />
      </ui-form-field>

      <ui-button type="primary" native-type="submit" block :loading="loading">
        {{ passwordLink.invite ? 'Set Password and Sign In' : 'Reset Password' }}
      </ui-button>
    </ui-form>

    <ui-result
      v-else-if="problem"
      :icon="problem.icon"
      type="warning"
      :title="problem.title"
      data-testid="set-password-problem"
    >
      {{ problem.text }}

      <template #actions>
        <ui-link to="/sign-in" unstyled>
          <ui-button>Go to Sign In</ui-button>
        </ui-link>
      </template>
    </ui-result>

    <div v-else class="flex justify-center py-6">
      <ui-spinner />
    </div>
  </ui-card>
</template>

<script setup lang="ts">
import { type Component, computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import IconLinkOff from '~icons/material-symbols/link-off-rounded';
import IconTaskAlt from '~icons/material-symbols/task-alt-rounded';
import IconTimerOff from '~icons/material-symbols/timer-off-outline-rounded';

import { type CheckedPasswordLinkDto, PasswordLinkState } from '@libs/dto';

import { Config } from '@/Config';

import { passwordMismatchError } from '@/utils/password';

import { useLogService } from '@/services/LogService';
import { usePasswordLinkService } from '@/services/api/PasswordLinkService';
import { useErrorStore } from '@/stores/error';

import {
  UiButton,
  UiCard,
  UiForm,
  UiFormField,
  UiFormHeading,
  UiInput,
  UiLink,
  UiResult,
  UiSpinner,
} from '@/components/ui';

interface ILinkProblem {
  icon: Component;
  title: string;
  text: string;
}

const FORM_NAME = 'set-password';

const logService = useLogService();
const logger = logService.createLogger('pages/loggedout/SetPassword');

const route = useRoute();

const errorStore = useErrorStore();
const passwordLinkService = usePasswordLinkService();

// The link carries the token in its fragment, so it never reaches the server's request logs.
const token = route.hash.replace(/^#/, '');

const state = ref<PasswordLinkState | null>(null);
const passwordLink = ref<CheckedPasswordLinkDto | null>(null);
const password = ref('');
const confirmPassword = ref('');
const loading = ref(false);

const problem = computed<ILinkProblem | null>(() => {
  switch (state.value) {
    case PasswordLinkState.INVALID:
      return {
        icon: IconLinkOff,
        title: "This link isn't valid",
        text: 'Check that you copied the full link, or ask your admin for a new one.',
      };
    case PasswordLinkState.EXPIRED:
      return {
        icon: IconTimerOff,
        title: 'This link has expired',
        text: 'Ask your admin for a new link.',
      };
    case PasswordLinkState.USED:
      return {
        icon: IconTaskAlt,
        title: 'This link has already been used',
        text: 'If you have already set your password, you can sign in. Otherwise, ask your admin for a new link.',
      };
    default:
      return null;
  }
});

const checkLink = async () => {
  // A malformed token can't name a link, and the api would refuse it as a bad request.
  if (!/^[0-9a-f]{64}$/.test(token)) {
    state.value = PasswordLinkState.INVALID;
    return;
  }

  const checked = await passwordLinkService.checkPasswordLink(token);

  passwordLink.value = checked.passwordLink;
  state.value = checked.state;
};

const doCheckLink = () => {
  checkLink().catch((error: unknown) => {
    logger.error({ error }, 'doCheckLink(): Failed to check the link');
    state.value = PasswordLinkState.INVALID;
  });
};

const doSetPassword = () => {
  if (loading.value) {
    return;
  }

  if (password.value !== confirmPassword.value) {
    errorStore.setValidationError(passwordMismatchError(FORM_NAME));
    return;
  }

  loading.value = true;

  // Once signed in, the auth middleware leaves this signed-out page for home.
  passwordLinkService
    .setPassword(token, password.value, FORM_NAME)
    .finally(() => {
      loading.value = false;
    })
    .catch((error: unknown) => {
      logger.error({ error }, 'doSetPassword(): Failed to set the password');

      // Any refusal but the password's means the link went while the page was open.
      if (errorStore.getFieldError(FORM_NAME, 'password') === undefined) {
        doCheckLink();
      }
    });
};

doCheckLink();
</script>
