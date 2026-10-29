<template>
  <ui-page-container>
    <ui-page-heading title="Profile &amp; security" subtitle="Your name, email and password." />

    <ui-form :name="PROFILE_FORM" layout="row" @submit="doSaveProfile">
      <ui-card title="Profile" subtitle="How you appear and the email you sign in with.">
        <ui-form-field v-slot="{ input }" label="Display name" help="Shown in the header." path="name">
          <ui-input
            v-model:value="name"
            v-bind="input"
            name="display-name"
            autocomplete="name"
            placeholder="Your name"
            :disabled="profileLoading"
          />
        </ui-form-field>

        <ui-form-field v-slot="{ input }" label="Email" help="Used to sign in." path="email">
          <ui-input
            v-model:value="email"
            v-bind="input"
            type="email"
            name="email"
            autocomplete="email"
            :disabled="profileLoading"
          />
        </ui-form-field>

        <template #footer>
          <ui-button type="primary" native-type="submit" :disabled="profileUnchanged" :loading="profileLoading">
            Save
          </ui-button>
        </template>
      </ui-card>
    </ui-form>

    <ui-form :name="PASSWORD_FORM" layout="row" @submit="doChangePassword">
      <ui-card
        title="Password"
        subtitle="Changing it signs you out everywhere else. You'll need to sign in again on each one."
      >
        <ui-form-field v-slot="{ input }" label="New password" path="password">
          <ui-input
            v-model:value="newPassword"
            v-bind="input"
            type="password"
            name="new-password"
            autocomplete="new-password"
            placeholder="New password"
            :disabled="passwordLoading"
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
            :disabled="passwordLoading"
          />
        </ui-form-field>

        <template #footer>
          <ui-button type="primary" native-type="submit" :loading="passwordLoading">Change Password</ui-button>
        </template>
      </ui-card>
    </ui-form>
  </ui-page-container>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { DialogType } from '@/types/dialog';

import { passwordMismatchError } from '@/utils/password';

import { useLogService } from '@/services/LogService';
import { useUserService } from '@/services/api/UserService';
import { useDialogStore } from '@/stores/dialog';
import { useErrorStore } from '@/stores/error';
import { useNotificationStore } from '@/stores/notification';
import { useUserStore } from '@/stores/user';

import { UiButton, UiCard, UiForm, UiFormField, UiInput, UiPageContainer, UiPageHeading } from '@/components/ui';

const PROFILE_FORM = 'profile';
const PASSWORD_FORM = 'password';

const logService = useLogService();
const logger = logService.createLogger('pages/loggedin/EditProfile');

const dialogStore = useDialogStore();
const errorStore = useErrorStore();
const notificationStore = useNotificationStore();
const userStore = useUserStore();
const userService = useUserService();

const name = ref('');
const email = ref('');
const profileLoading = ref(false);

const newPassword = ref('');
const confirmPassword = ref('');
const passwordLoading = ref(false);

const profileUnchanged = computed(
  () => name.value.trim() === (userStore.profile?.name ?? '') && email.value.trim() === (userStore.profile?.email ?? '')
);

// Every navigation reloads the profile; refill only when the saved values change, so typed edits survive it.
watch(
  () => [userStore.profile?.name ?? '', userStore.profile?.email ?? ''],
  ([profileName, profileEmail]) => {
    name.value = profileName;
    email.value = profileEmail;
  },
  { immediate: true }
);

const doSaveProfile = () => {
  if (profileLoading.value) {
    return;
  }

  profileLoading.value = true;

  userService
    .updateProfile({ name: name.value.trim(), email: email.value.trim() }, PROFILE_FORM)
    .then(() => {
      notificationStore.addToast('Profile updated', 'Your changes have been saved.');
    })
    .finally(() => {
      profileLoading.value = false;
    })
    .catch((error: unknown) => {
      logger.error({ error }, 'doSaveProfile(): Failed to update the profile');
    });
};

const changePassword = async () => {
  const confirmed = await dialogStore.confirm({
    type: DialogType.WARNING,
    title: 'Change your password?',
    message: 'Anywhere else you are signed in is signed out and has to sign in again.',
    confirmLabel: 'Change Password',
  });

  if (!confirmed) {
    return;
  }

  passwordLoading.value = true;

  try {
    await userService.updateProfile(
      {
        name: userStore.profile?.name ?? '',
        email: userStore.profile?.email ?? '',
        password: newPassword.value,
      },
      PASSWORD_FORM
    );
  } finally {
    passwordLoading.value = false;
  }

  newPassword.value = '';
  confirmPassword.value = '';
  notificationStore.addToast('Password changed', 'Use your new password the next time you sign in.');
};

const doChangePassword = () => {
  if (passwordLoading.value) {
    return;
  }

  if (newPassword.value !== confirmPassword.value) {
    errorStore.setValidationError(passwordMismatchError(PASSWORD_FORM));
    return;
  }

  // A request clears the last refusal, but the confirm dialog shows before it.
  errorStore.clearValidationError();

  changePassword().catch((error: unknown) => {
    logger.error({ error }, 'doChangePassword(): Failed to change the password');
  });
};
</script>
