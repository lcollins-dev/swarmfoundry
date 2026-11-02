<template>
  <div class="flex flex-col gap-3" data-testid="password-link">
    <ui-notice v-if="props.passwordLink.emailed" type="success" :title="`Emailed to ${props.email}`">
      The email includes the link below. Copy it now if you need it later - it won't be shown again.
    </ui-notice>

    <ui-notice v-else type="warning" title="Email not sent">
      Copy this link and share it with the user. It won't be shown again.
    </ui-notice>

    <div class="rounded-md border border-divider">
      <ui-copy-value :value="props.passwordLink.link" label="Link" value-test-id="password-link-value" />
    </div>

    <p class="m-0 text-xs text-muted" data-testid="password-link-expiry">
      Single-use link. Expires {{ formatDayTime(props.passwordLink.expiresAt) }}. A newer
      {{ props.invite ? 'invite' : 'link' }}
      invalidates this link.
    </p>
  </div>
</template>

<script setup lang="ts">
import { PropType } from 'vue';

import type { PasswordLinkDto } from '@libs/dto';

import { formatDayTime } from '@/utils/format/date';

import { UiCopyValue, UiNotice } from '@/components/ui';

const props = defineProps({
  passwordLink: {
    type: Object as PropType<PasswordLinkDto>,
    required: true,
  },
  email: {
    type: String,
    required: true,
  },
  invite: {
    type: Boolean,
    default: false,
  },
});
</script>
