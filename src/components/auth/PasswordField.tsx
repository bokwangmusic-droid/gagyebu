/**
 * Password input with a show/hide toggle — STEP 16-E UX fix.
 *
 * Same visual style as controls.tsx's <TextField/> (deliberately not
 * modified — it's shared by many non-Auth screens) with a right-aligned
 * eye/eye-off button. Toggling only flips the local `visible` state that
 * drives `secureTextEntry`; the TextInput itself is never remounted (same
 * component identity every render) and `value`/`onChangeText` stay fully
 * owned by the caller, so the typed password and cursor focus are both
 * unaffected by toggling. Reuses lucide-react-native (already a
 * dependency, via <AppIcon/>) — no new icon package.
 */
import { forwardRef, useState } from 'react';
import { Pressable, TextInput, View, type TextInputProps } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { colors, radii } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

export const PasswordField = forwardRef<TextInput, Omit<TextInputProps, 'secureTextEntry'>>(
  function PasswordField(props, ref) {
    const [visible, setVisible] = useState(false);

    return (
      <View style={{ justifyContent: 'center' }}>
        <TextInput
          ref={ref}
          placeholderTextColor={colors.textMuted}
          {...props}
          secureTextEntry={!visible}
          style={[
            {
              width: '100%',
              paddingVertical: 12,
              paddingHorizontal: 14,
              paddingRight: 44,
              backgroundColor: colors.white,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radii.md,
              fontFamily: fontFamily.regular,
              fontSize: 15,
              color: colors.text,
            },
            props.style,
          ]}
        />
        <Pressable
          onPress={() => setVisible((v) => !v)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={visible ? '비밀번호 숨기기' : '비밀번호 보기'}
          style={{
            position: 'absolute',
            right: 4,
            top: 0,
            bottom: 0,
            justifyContent: 'center',
            paddingHorizontal: 10,
          }}
        >
          <AppIcon name={visible ? 'eye-off' : 'eye'} size={18} color={colors.textMuted} />
        </Pressable>
      </View>
    );
  },
);

export default PasswordField;
