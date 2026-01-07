/**
 * ScreenLayout - Standard layout wrapper for all TUI screens
 *
 * Enforces consistent visual structure across the application:
 * - Frame with border and footer
 * - Header with title and optional subtitle
 * - Content area
 * - HintBar with keyboard shortcuts
 */

import React, { type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { Frame, Divider, HintBar } from './Layout.js';
import { colors, icons } from './theme.js';

interface ScreenLayoutProps {
  /** Screen title - displayed prominently at top */
  title: ReactNode;
  /** Optional subtitle - displayed below title in muted color */
  subtitle?: string;
  /** Screen content */
  children: ReactNode;
  /** Custom hint strings, defaults to navigate/select/back */
  hints?: string[];
  /** Border color for the frame, defaults to focus blue */
  borderColor?: string;
  /** Optional icon to show before title */
  icon?: keyof typeof icons | null;
}

/**
 * Standard screen layout component
 *
 * Usage:
 * ```tsx
 * <ScreenLayout title="Select Provider" subtitle="Choose your API gateway">
 *   <MyContent />
 * </ScreenLayout>
 * ```
 */
export const ScreenLayout: React.FC<ScreenLayoutProps> = ({
  title,
  subtitle,
  children,
  hints,
  borderColor = colors.borderFocus,
  icon = 'bullet',
}) => {
  const renderTitle = () => {
    if (typeof title === 'string' || typeof title === 'number') {
      return (
        <Text color={colors.textBright} bold>
          {title}
        </Text>
      );
    }
    return title;
  };

  return (
    <Frame borderColor={borderColor}>
      {/* Header */}
      <Box marginBottom={1}>
        {icon && (
          <Text color={colors.gold} bold>
            {icons[icon]}{' '}
          </Text>
        )}
        {renderTitle()}
      </Box>
      {subtitle && <Text color={colors.textMuted}>{subtitle}</Text>}

      <Divider color={colors.border} />

      {/* Content Area */}
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>

      {/* Bottom Navigation */}
      <Divider />
      <HintBar hints={hints} />
    </Frame>
  );
};
