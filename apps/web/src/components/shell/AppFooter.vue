<template>
  <footer class="flex items-center justify-center gap-1.5 text-xs text-muted">
    <span>{{ Config.APP_NAME }} {{ Config.VERSION }}</span>
    <span aria-hidden="true">·</span>
    <ui-link :to="Config.SOURCE_URL" external target="_blank">Source code</ui-link>
  </footer>
</template>

<script setup lang="ts">
import { Config } from '@/Config';

import { UiLink } from '@/components/ui';
</script>
