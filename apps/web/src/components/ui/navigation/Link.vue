<script lang="ts">
import { PropType, h } from 'vue';
import { RouterLink, RouteLocationRaw } from 'vue-router';

export default {
  props: {
    to: {
      type: [Object, String] as PropType<RouteLocationRaw>,
      default: '',
    },
    replace: {
      type: Boolean,
      default: false,
    },
    external: {
      type: Boolean,
      default: false,
    },
    target: {
      type: String as PropType<string | undefined>,
      default: undefined,
    },
    unstyled: {
      type: Boolean,
      default: false,
    },
  },
  setup(props, { slots }) {
    return () => {
      const styleProps = !props.unstyled ? { class: 'text-accent hover:text-primary-hover' } : {};

      if (props.external) {
        return h('a', { href: props.to, target: props.target, ...styleProps }, slots.default?.());
      }

      return h(
        RouterLink,
        {
          to: props.to,
          replace: props.replace,
          ...styleProps,
        },
        slots.default
      );
    };
  },
};
</script>
