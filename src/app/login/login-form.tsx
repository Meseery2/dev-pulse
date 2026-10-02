"use client";

import { useActionState } from "react";
import { AlertCircleIcon, LogInIcon } from "lucide-react";
import { login, type LoginState } from "./actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});

  return (
    <form action={action}>
      <FieldGroup>
        {state.error ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>Sign in failed</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}

        <Field>
          <FieldLabel htmlFor="username">Username</FieldLabel>
          <Input
            id="username"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>

        <Button type="submit" disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" /> : <LogInIcon data-icon="inline-start" />}
          Sign in
        </Button>
      </FieldGroup>
    </form>
  );
}
