<template>
  <ui-card class="mx-auto mt-10 max-w-sm">
    <ui-form-heading :title="`Welcome to ${Config.APP_NAME}`" subtitle="Sign in to reach your dashboard." />

    <div class="flex flex-col gap-3">
      <ui-link to="/sign-in" unstyled>
        <ui-button type="primary" block>Sign In</ui-button>
      </ui-link>

      <ui-link v-if="userStore.canRegister" to="/register" unstyled>
        <ui-button block>Create Account</ui-button>
      </ui-link>
    </div>
  </ui-card>
</template>

<script setup lang="ts">
import { Config } from '@/Config';

import { useUserStore } from '@/stores/user';

import { UiButton, UiCard, UiFormHeading, UiLink } from '@/components/ui';

const userStore = useUserStore();
</script>
