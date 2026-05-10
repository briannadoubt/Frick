import {
  Children,
  isValidElement,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ElementType,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { FrickIconGlyph, type FrickIconName } from "./icons.js";

type Size = "xs" | "sm" | "md" | "lg";
type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "info" | "muted";
type Gap = "none" | "xs" | "sm" | "md" | "lg" | "xl";
type Align = "start" | "center" | "end" | "stretch";
type Justify = "start" | "center" | "end" | "between";
type UnknownRecord = Record<string, unknown>;
type FrickStyle = CSSProperties & Record<`--frick-${string}`, string | number>;

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function getValue<T extends UnknownRecord>(row: T, accessor: keyof T | ((row: T) => ReactNode)): ReactNode {
  return typeof accessor === "function" ? accessor(row) : (row[accessor] as ReactNode);
}

export interface TextProps extends HTMLAttributes<HTMLElement> {
  as?: "p" | "span" | "small";
  size?: Size;
  tone?: Tone;
}

export function Text({ as: Tag = "p", size = "md", tone = "neutral", className, ...props }: TextProps) {
  return <Tag className={cx("frick-text", `frick-text--${size}`, `frick-tone--${tone}`, className)} {...props} />;
}

export interface HeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  size?: "sm" | "md" | "lg" | "xl";
}

export function Heading({ level = 2, size = "lg", className, ...props }: HeadingProps) {
  const Tag = `h${level}` as ElementType;
  return <Tag className={cx("frick-heading", `frick-heading--${size}`, className)} {...props} />;
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cx("frick-label", className)} {...props} />;
}

export function Divider({ className, ...props }: HTMLAttributes<HTMLHRElement>) {
  return <hr className={cx("frick-divider", className)} {...props} />;
}

export interface SpacerProps extends HTMLAttributes<HTMLDivElement> {
  size?: Gap;
}

export function Spacer({ size = "md", className, ...props }: SpacerProps) {
  return <div aria-hidden="true" className={cx("frick-spacer", `frick-spacer--${size}`, className)} {...props} />;
}

export interface LayoutProps extends HTMLAttributes<HTMLDivElement> {
  gap?: Gap;
  align?: Align;
  justify?: Justify;
}

export function Surface({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <section className={cx("frick-surface", className)} {...props} />;
}

export function Stack({ gap = "md", align = "stretch", className, ...props }: LayoutProps) {
  return <div className={cx("frick-stack", `frick-gap--${gap}`, `frick-align--${align}`, className)} {...props} />;
}

export function Inline({ gap = "sm", align = "center", className, ...props }: LayoutProps) {
  return <div className={cx("frick-inline", `frick-gap--${gap}`, `frick-align--${align}`, className)} {...props} />;
}

export function Cluster({ gap = "sm", align = "center", justify = "start", className, ...props }: LayoutProps) {
  return (
    <div
      className={cx("frick-cluster", `frick-gap--${gap}`, `frick-align--${align}`, `frick-justify--${justify}`, className)}
      {...props}
    />
  );
}

export interface AppShellProps extends HTMLAttributes<HTMLDivElement> {
  sidebar?: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
}

export function AppShell({ sidebar, header, footer, children, className, ...props }: AppShellProps) {
  return (
    <div className={cx("frick-app-shell", className)} {...props}>
      {sidebar ? <aside className="frick-app-shell__sidebar">{sidebar}</aside> : null}
      <div className="frick-app-shell__body">
        {header ? <header className="frick-app-shell__header">{header}</header> : null}
        <main className="frick-app-shell__main">{children}</main>
        {footer ? <footer className="frick-app-shell__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

export interface WorkspaceDestination {
  id: string;
  label: ReactNode;
  icon?: FrickIconName;
  disabled?: boolean;
  badge?: ReactNode;
}

export interface WorkspaceShellProps extends HTMLAttributes<HTMLDivElement> {
  destinations: WorkspaceDestination[];
  selectedDestination: string;
  onDestinationChange?: (destinationId: string) => void;
  collection?: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  inspector?: ReactNode;
  inspectorOpen?: boolean;
  navigationLabel?: ReactNode;
  navigationActions?: ReactNode;
  compactCollectionVisible?: boolean;
  onInspectorOpenChange?: (open: boolean) => void;
}

export function WorkspaceShell({
  destinations,
  selectedDestination,
  onDestinationChange,
  collection,
  header,
  footer,
  inspector,
  inspectorOpen = Boolean(inspector),
  navigationLabel,
  navigationActions,
  compactCollectionVisible = false,
  onInspectorOpenChange,
  children,
  className,
  ...props
}: WorkspaceShellProps) {
  const hasCollection = Boolean(collection);
  const hasInspector = Boolean(inspector) && inspectorOpen;

  return (
    <div className={cx("frick-workspace-shell", className)} {...props}>
      <nav className="frick-workspace-shell__destinations" aria-label="Workspace destinations">
        {navigationLabel ? <div className="frick-workspace-shell__brand">{navigationLabel}</div> : null}
        <div className="frick-workspace-shell__destination-list">
          {destinations.map((destination) => {
            const selected = destination.id === selectedDestination;
            return (
              <button
                aria-current={selected ? "page" : undefined}
                className="frick-workspace-shell__destination"
                data-selected={selected}
                disabled={destination.disabled}
                key={destination.id}
                onClick={() => onDestinationChange?.(destination.id)}
                type="button"
              >
                {destination.icon ? <FrickIconGlyph name={destination.icon} /> : null}
                <span>{destination.label}</span>
                {destination.badge ? <b>{destination.badge}</b> : null}
              </button>
            );
          })}
        </div>
        {navigationActions ? <div className="frick-workspace-shell__navigation-actions">{navigationActions}</div> : null}
      </nav>

      <div
        className="frick-workspace-shell__body"
        data-compact-collection-visible={compactCollectionVisible}
        data-has-collection={hasCollection}
        data-has-inspector={hasInspector}
      >
        {collection ? <aside className="frick-workspace-shell__collection">{collection}</aside> : null}
        <section className="frick-workspace-shell__content-shell">
          {header ? <header className="frick-workspace-shell__header">{header}</header> : null}
          <main className="frick-workspace-shell__content">{children}</main>
          {footer ? <footer className="frick-workspace-shell__footer">{footer}</footer> : null}
        </section>
        {inspector ? (
          <aside className="frick-workspace-shell__inspector" data-open={inspectorOpen}>
            <div className="frick-workspace-shell__inspector-actions">
              <button type="button" onClick={() => onInspectorOpenChange?.(false)}>
                Close
              </button>
            </div>
            {inspector}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

export interface WorkspaceListItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  selected?: boolean;
  badge?: ReactNode;
}

export function WorkspaceListItem({
  title,
  subtitle,
  meta,
  selected = false,
  badge,
  className,
  type = "button",
  ...props
}: WorkspaceListItemProps) {
  return (
    <button className={cx("frick-workspace-list-item", className)} data-selected={selected} type={type} {...props}>
      <span className="frick-workspace-list-item__body">
        <strong>{title}</strong>
        {subtitle ? <small>{subtitle}</small> : null}
        {meta ? <small className="frick-workspace-list-item__meta">{meta}</small> : null}
      </span>
      {badge ? <b>{badge}</b> : null}
    </button>
  );
}

export function Toolbar({ gap = "sm", align = "center", className, ...props }: LayoutProps) {
  return (
    <div
      role="toolbar"
      className={cx("frick-toolbar", `frick-gap--${gap}`, `frick-align--${align}`, className)}
      {...props}
    />
  );
}

export function ScrollArea({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("frick-scroll-area", className)} {...props} />;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: Exclude<Tone, "muted">;
  size?: Exclude<Size, "xs">;
  icon?: FrickIconName;
}

export function Button({ tone = "neutral", size = "md", icon, className, children, type = "button", ...props }: ButtonProps) {
  return (
    <button className={cx("frick-button", `frick-button--${tone}`, `frick-button--${size}`, className)} type={type} {...props}>
      {icon ? <FrickIconGlyph className="frick-button__icon" name={icon} /> : null}
      <span>{children}</span>
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: FrickIconName;
  label: string;
  tone?: Exclude<Tone, "muted">;
}

export function IconButton({ icon, label, tone = "neutral", className, type = "button", ...props }: IconButtonProps) {
  return (
    <button
      aria-label={label}
      className={cx("frick-icon-button", `frick-icon-button--${tone}`, className)}
      title={label}
      type={type}
      {...props}
    >
      <FrickIconGlyph name={icon} />
    </button>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: ReactNode;
  error?: ReactNode;
  hint?: ReactNode;
}

export function TextField({ label, error, hint, className, id, ...props }: TextFieldProps) {
  const inputId = id ?? (typeof label === "string" ? `frick-field-${label.toLowerCase().replace(/\s+/g, "-")}` : undefined);
  return (
    <div className={cx("frick-field", className)}>
      {label ? <Label htmlFor={inputId}>{label}</Label> : null}
      <input aria-invalid={Boolean(error) || undefined} className="frick-input" id={inputId} {...props} />
      {hint ? <div className="frick-field__hint">{hint}</div> : null}
      {error ? <div className="frick-field__error">{error}</div> : null}
    </div>
  );
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  error?: ReactNode;
  hint?: ReactNode;
}

export function TextArea({ label, error, hint, className, id, ...props }: TextAreaProps) {
  const inputId = id ?? (typeof label === "string" ? `frick-area-${label.toLowerCase().replace(/\s+/g, "-")}` : undefined);
  return (
    <div className={cx("frick-field", className)}>
      {label ? <Label htmlFor={inputId}>{label}</Label> : null}
      <textarea aria-invalid={Boolean(error) || undefined} className="frick-textarea" id={inputId} {...props} />
      {hint ? <div className="frick-field__hint">{hint}</div> : null}
      {error ? <div className="frick-field__error">{error}</div> : null}
    </div>
  );
}

export interface SegmentedOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps extends HTMLAttributes<HTMLDivElement> {
  label?: ReactNode;
  value?: string;
  options: SegmentedOption[];
  onValueChange?: (value: string) => void;
}

export function SegmentedControl({ label, value, options, onValueChange, className, ...props }: SegmentedControlProps) {
  return (
    <div className={cx("frick-segmented", className)} {...props}>
      {label ? <div className="frick-segmented__label">{label}</div> : null}
      <div className="frick-segmented__options">
        {options.map((option) => (
          <button
            aria-pressed={option.value === value}
            className="frick-segmented__option"
            disabled={option.disabled}
            key={option.value}
            onClick={() => onValueChange?.(option.value)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: ReactNode;
}

export function Toggle({ label, className, ...props }: ToggleProps) {
  return (
    <label className={cx("frick-toggle", className)}>
      <input className="frick-toggle__input" type="checkbox" {...props} />
      <span className="frick-toggle__track" aria-hidden="true">
        <span className="frick-toggle__thumb" />
      </span>
      {label ? <span className="frick-toggle__label">{label}</span> : null}
    </label>
  );
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

export function Badge({ tone = "neutral", className, ...props }: BadgeProps) {
  return <span className={cx("frick-badge", `frick-badge--${tone}`, className)} {...props} />;
}

export interface StatusChipProps extends BadgeProps {
  icon?: FrickIconName;
}

export function StatusChip({ icon, children, className, ...props }: StatusChipProps) {
  return (
    <Badge className={cx("frick-status-chip", className)} {...props}>
      {icon ? <FrickIconGlyph name={icon} /> : null}
      <span>{children}</span>
    </Badge>
  );
}

export interface PresenceDotProps extends HTMLAttributes<HTMLSpanElement> {
  status?: "online" | "away" | "busy" | "offline";
  label?: string;
}

export function PresenceDot({ status = "offline", label = status, className, ...props }: PresenceDotProps) {
  return <span aria-label={label} className={cx("frick-presence-dot", className)} data-status={status} role="img" {...props} />;
}

export interface ProgressRingProps extends HTMLAttributes<HTMLDivElement> {
  value: number;
  label?: string;
}

export function ProgressRing({ value, label = `${value}%`, className, ...props }: ProgressRingProps) {
  const normalized = Math.max(0, Math.min(100, value));
  const style: FrickStyle = { "--frick-progress-value": normalized };
  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={normalized}
      className={cx("frick-progress-ring", className)}
      role="progressbar"
      style={style}
      {...props}
    >
      <span>{label}</span>
    </div>
  );
}

export interface ToastProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: Tone;
  title?: ReactNode;
}

export function Toast({ tone = "neutral", title, children, className, ...props }: ToastProps) {
  return (
    <div className={cx("frick-toast", `frick-toast--${tone}`, className)} role="status" {...props}>
      {title ? <strong>{title}</strong> : null}
      {children ? <div>{children}</div> : null}
    </div>
  );
}

export interface ErrorMessageProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
}

export function ErrorMessage({ title = "Something went wrong", children, className, ...props }: ErrorMessageProps) {
  return (
    <div className={cx("frick-error", className)} role="alert" {...props}>
      <strong>{title}</strong>
      {children ? <div>{children}</div> : null}
    </div>
  );
}

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, action, children, className, ...props }: EmptyStateProps) {
  return (
    <div className={cx("frick-empty", className)} {...props}>
      <Heading level={3} size="sm">
        {title}
      </Heading>
      {children ? <Text tone="muted">{children}</Text> : null}
      {action ? <div className="frick-empty__action">{action}</div> : null}
    </div>
  );
}

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  name: string;
  src?: string | undefined;
  size?: Exclude<Size, "xs">;
}

export function Avatar({ name, src, size = "md", className, ...props }: AvatarProps) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return (
    <span aria-label={name} className={cx("frick-avatar", `frick-avatar--${size}`, className)} {...props}>
      {src ? <img alt="" src={src} /> : initials}
    </span>
  );
}

export interface AvatarGroupProps extends HTMLAttributes<HTMLDivElement> {
  users: Array<{ id: string; name: string; src?: string }>;
  max?: number;
}

export function AvatarGroup({ users, max = 4, className, ...props }: AvatarGroupProps) {
  const visible = users.slice(0, max);
  const overflow = users.length - visible.length;
  return (
    <div className={cx("frick-avatar-group", className)} {...props}>
      {visible.map((user) => (
        <Avatar key={user.id} name={user.name} src={user.src} size="sm" />
      ))}
      {overflow > 0 ? <span className="frick-avatar frick-avatar--sm">+{overflow}</span> : null}
    </div>
  );
}

export interface UserRowProps extends HTMLAttributes<HTMLDivElement> {
  name: string;
  detail?: ReactNode;
  src?: string;
  presence?: PresenceDotProps["status"];
  action?: ReactNode;
}

export function UserRow({ name, detail, src, presence, action, className, ...props }: UserRowProps) {
  return (
    <div className={cx("frick-user-row", className)} {...props}>
      <Avatar name={name} src={src} />
      <div className="frick-user-row__body">
        <strong>{name}</strong>
        {detail ? <span>{detail}</span> : null}
      </div>
      {presence ? <PresenceDot status={presence} /> : null}
      {action ? <div className="frick-user-row__action">{action}</div> : null}
    </div>
  );
}

export function MessageList({ className, tabIndex = 0, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("frick-message-list", className)} role="log" tabIndex={tabIndex} {...props} />;
}

export interface ChatBubbleProps extends HTMLAttributes<HTMLDivElement> {
  author?: ReactNode;
  timestamp?: ReactNode;
  variant?: "incoming" | "outgoing" | "system";
}

export function ChatBubble({ author, timestamp, variant = "incoming", children, className, ...props }: ChatBubbleProps) {
  return (
    <article className={cx("frick-chat-bubble", `frick-chat-bubble--${variant}`, className)} {...props}>
      {author || timestamp ? (
        <header>
          {author ? <strong>{author}</strong> : null}
          {timestamp ? <time>{timestamp}</time> : null}
        </header>
      ) : null}
      <div className="frick-chat-bubble__content">{children}</div>
    </article>
  );
}

export interface ComposerProps extends HTMLAttributes<HTMLFormElement> {
  placeholder?: string;
  actionLabel?: string;
  submitOnEnter?: boolean;
}

export function Composer({ placeholder = "Message", actionLabel = "Send", submitOnEnter = true, className, ...props }: ComposerProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!submitOnEnter || event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <form className={cx("frick-composer", className)} {...props}>
      <textarea aria-label={placeholder} className="frick-composer__input" onKeyDown={handleKeyDown} placeholder={placeholder} />
      <IconButton icon="send" label={actionLabel} />
    </form>
  );
}

export function TypingIndicator({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div aria-label="Typing" className={cx("frick-typing", className)} role="status" {...props}>
      <span />
      <span />
      <span />
    </div>
  );
}

export interface ReceiptProps extends HTMLAttributes<HTMLSpanElement> {
  status?: "sent" | "delivered" | "read";
}

export function Receipt({ status = "sent", className, ...props }: ReceiptProps) {
  return <span className={cx("frick-receipt", className)} data-status={status} {...props} />;
}

export interface ReactionProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  symbol: ReactNode;
  count?: number;
}

export function Reaction({ symbol, count, className, type = "button", ...props }: ReactionProps) {
  return (
    <button className={cx("frick-reaction", className)} type={type} {...props}>
      <span>{symbol}</span>
      {typeof count === "number" ? <span>{count}</span> : null}
    </button>
  );
}

export interface SignalProps extends HTMLAttributes<HTMLDivElement> {
  tone?: Tone;
  label: ReactNode;
}

export function Signal({ tone = "info", label, className, children, ...props }: SignalProps) {
  return (
    <div className={cx("frick-signal", `frick-signal--${tone}`, className)} {...props}>
      <FrickIconGlyph name="live" />
      <strong>{label}</strong>
      {children ? <span>{children}</span> : null}
    </div>
  );
}

export interface CallProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
}

export function Call({ title, status, actions, className, children, ...props }: CallProps) {
  return (
    <div className={cx("frick-call", className)} {...props}>
      <div>
        <strong>{title}</strong>
        {status ? <span>{status}</span> : null}
      </div>
      {children}
      {actions ? <div className="frick-call__actions">{actions}</div> : null}
    </div>
  );
}

export interface ColumnProps<T extends UnknownRecord = UnknownRecord> {
  id: string;
  header: ReactNode;
  accessor: keyof T | ((row: T) => ReactNode);
  align?: "start" | "center" | "end";
}

export function Column<T extends UnknownRecord>(_props: ColumnProps<T>) {
  return null;
}

export interface CellProps extends HTMLAttributes<HTMLDivElement> {
  align?: "start" | "center" | "end";
}

export function Cell({ align = "start", className, ...props }: CellProps) {
  return <div className={cx("frick-cell", className)} data-align={align} {...props} />;
}

export interface DataTableProps<T extends UnknownRecord> extends HTMLAttributes<HTMLTableElement> {
  rows: T[];
  rowKey: keyof T | ((row: T) => string);
  children: ReactNode;
}

export function DataTable<T extends UnknownRecord>({ rows, rowKey, children, className, ...props }: DataTableProps<T>) {
  const columns = Children.toArray(children).filter(isValidElement) as Array<ReactElement<ColumnProps<T>>>;
  return (
    <table className={cx("frick-data-table", className)} {...props}>
      <thead>
        <tr>
          {columns.map((column) => (
            <th data-align={column.props.align ?? "start"} key={column.props.id}>
              {column.props.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const key = typeof rowKey === "function" ? rowKey(row) : String(row[rowKey]);
          return (
            <tr key={key}>
              {columns.map((column) => (
                <td data-align={column.props.align ?? "start"} key={column.props.id}>
                  {getValue(row, column.props.accessor)}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export interface DataGridProps extends HTMLAttributes<HTMLDivElement> {
  columns?: number;
}

export function DataGrid({ columns = 3, className, style, ...props }: DataGridProps) {
  const gridStyle: FrickStyle = { "--frick-data-grid-columns": columns, ...style };
  return <div className={cx("frick-data-grid", className)} style={gridStyle} {...props} />;
}

export interface MetricProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  value: ReactNode;
  delta?: ReactNode;
}

export function Metric({ label, value, delta, className, ...props }: MetricProps) {
  return (
    <div className={cx("frick-metric", className)} {...props}>
      <span>{label}</span>
      <strong>{value}</strong>
      {delta ? <em>{delta}</em> : null}
    </div>
  );
}

export interface TimelineItem {
  id: string;
  title: ReactNode;
  time?: ReactNode;
  detail?: ReactNode;
  tone?: Tone;
}

export interface TimelineProps extends HTMLAttributes<HTMLOListElement> {
  items: TimelineItem[];
}

export function Timeline({ items, className, ...props }: TimelineProps) {
  return (
    <ol className={cx("frick-timeline", className)} {...props}>
      {items.map((item) => (
        <li data-tone={item.tone ?? "neutral"} key={item.id}>
          <span className="frick-timeline__marker" />
          <div>
            <strong>{item.title}</strong>
            {item.time ? <time>{item.time}</time> : null}
            {item.detail ? <p>{item.detail}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function DatePicker(props: TextFieldProps) {
  return <TextField type="date" {...props} />;
}

export function TimePicker(props: TextFieldProps) {
  return <TextField type="time" {...props} />;
}

export interface ChartSurfaceProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
}

export function ChartSurface({ title, children, className, ...props }: ChartSurfaceProps) {
  return (
    <section className={cx("frick-chart-surface", className)} {...props}>
      {title ? <Heading level={3} size="sm">{title}</Heading> : null}
      <div className="frick-chart-surface__body">{children}</div>
    </section>
  );
}

export interface SeriesChartProps extends HTMLAttributes<SVGSVGElement> {
  data: number[];
  label: string;
}

function pointsFor(data: number[], width = 100, height = 40): string {
  const max = Math.max(...data, 1);
  const last = Math.max(data.length - 1, 1);
  return data.map((value, index) => `${(index / last) * width},${height - (value / max) * height}`).join(" ");
}

export function LineChart({ data, label, className, ...props }: SeriesChartProps) {
  return (
    <svg aria-label={label} className={cx("frick-chart", "frick-line-chart", className)} role="img" viewBox="0 0 100 40" {...props}>
      <polyline fill="none" points={pointsFor(data)} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function BarChart({ data, label, className, ...props }: SeriesChartProps) {
  const max = Math.max(...data, 1);
  const slot = 100 / Math.max(data.length, 1);
  return (
    <svg aria-label={label} className={cx("frick-chart", "frick-bar-chart", className)} role="img" viewBox="0 0 100 40" {...props}>
      {data.map((value, index) => {
        const height = (value / max) * 40;
        return <rect height={height} key={`${value}-${index}`} width={slot * 0.7} x={index * slot + slot * 0.15} y={40 - height} />;
      })}
    </svg>
  );
}

export function AreaChart({ data, label, className, ...props }: SeriesChartProps) {
  const points = pointsFor(data);
  return (
    <svg aria-label={label} className={cx("frick-chart", "frick-area-chart", className)} role="img" viewBox="0 0 100 40" {...props}>
      <path d={`M ${points} L 100 40 L 0 40 Z`} />
      <polyline fill="none" points={points} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Sparkline({ data, label, className, ...props }: SeriesChartProps) {
  return (
    <svg aria-label={label} className={cx("frick-chart", "frick-sparkline", className)} role="img" viewBox="0 0 100 24" {...props}>
      <polyline fill="none" points={pointsFor(data, 100, 24)} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function PieChart({ data, label, className, ...props }: SeriesChartProps) {
  const total = data.reduce((sum, value) => sum + value, 0) || 1;
  let offset = 0;
  return (
    <svg aria-label={label} className={cx("frick-chart", "frick-pie-chart", className)} role="img" viewBox="0 0 42 42" {...props}>
      {data.map((value, index) => {
        const portion = value / total;
        const dash = `${portion * 100} ${100 - portion * 100}`;
        const segmentOffset = offset;
        offset -= portion * 100;
        const style: FrickStyle = { "--frick-chart-segment": `var(--frick-chart-${(index % 4) + 1})` };
        return (
          <circle
            cx="21"
            cy="21"
            fill="transparent"
            key={`${value}-${index}`}
            r="15.9"
            strokeDasharray={dash}
            strokeDashoffset={segmentOffset}
            style={style}
          />
        );
      })}
    </svg>
  );
}
