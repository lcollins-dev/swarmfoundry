export const formatNumber = (value: number): string => Math.round(value).toLocaleString();

export const formatNumberAbbreviated = (value: number): string => {
  const abs = Math.abs(value);

  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }

  if (abs >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  }

  return String(Math.round(value));
};

/** Dollars to the cent, such as `$13.04`. */
export const formatUsd = (value: number): string => `$${value.toFixed(2)}`;
