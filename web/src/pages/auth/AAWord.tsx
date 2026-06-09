type AAWordProps = {
  size?: "sm" | "lg" | "xl";
};

export function AAWord({ size = "sm" }: AAWordProps) {
  const cls = ["aa-word", size === "xl" ? "xl" : size === "lg" ? "lg" : ""]
    .filter(Boolean)
    .join(" ");
  return <span className={cls}>Agents Anywhere</span>;
}
