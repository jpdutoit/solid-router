import { JSX, Accessor, runWithOwner } from "solid-js";
import {
  createComponent,
  createContext,
  createMemo,
  createRenderEffect,
  createSignal,
  on,
  onCleanup,
  untrack,
  useContext,
  startTransition,
  resetErrorBoundaries
} from "solid-js";
import { isServer, getRequestEvent } from "solid-js/web";
import { createBeforeLeave } from "./lifecycle.js";
import type {
  BeforeLeaveEventArgs,
  Branch,
  Intent,
  Location,
  LocationChange,
  MatchFilters,
  MaybePreloadableComponent,
  NavigateOptions,
  Navigator,
  Params,
  Route,
  RouteContext,
  RouteDefinition,
  RouteMatch,
  RouterContext,
  RouterIntegration,
  SetParams,
  Submission
} from "./types.js";
import {
  mockBase,
  createMemoObject,
  extractSearchParams,
  invariant,
  resolvePath,
  createMatcher,
  joinPaths,
  scoreRoute,
  mergeSearchString,
  expandOptionals
} from "./utils.js";

const MAX_REDIRECTS = 100;

export const RouterContextObj = createContext<RouterContext>();
export const RouteContextObj = createContext<RouteContext>();

export const useRouter = () =>
  invariant(
    useContext(RouterContextObj),
    "<A> and 'use' router primitives can be only used inside a Route."
  );

let TempRoute: RouteContext | undefined;
export const useRoute = () => TempRoute || useContext(RouteContextObj) || useRouter().base;

export const useResolvedPath = (path: () => string) => {
  const route = useRoute();
  return createMemo(() => route.resolvePath(path()));
};

export const useHref = (to: () => string | undefined) => {
  const router = useRouter();
  return createMemo(() => {
    const to_ = to();
    return to_ !== undefined ? router.renderPath(to_) : to_;
  });
};

export const useNavigate = () => useRouter().navigatorFactory();
export const useLocation = <S = unknown>() => useRouter().location as Location<S>;
export const useIsRouting = () => useRouter().isRouting;

export const useMatch = <S extends string>(path: () => S, matchFilters?: MatchFilters<S>) => {
  const location = useLocation();
  const matchers = createMemo(() =>
    expandOptionals(path()).map(path => createMatcher(path, undefined, matchFilters))
  );
  return createMemo(() => {
    for (const matcher of matchers()) {
      const match = matcher(location.pathname);
      if (match) return match;
    }
  });
};

export const useCurrentMatches = () => useRouter().matches;

export const useParams = <T extends Params>() => useRouter().params as T;

export const useSearchParams = <T extends Params>(): [
  Partial<T>,
  (params: SetParams, options?: Partial<NavigateOptions>) => void
] => {
  const location = useLocation();
  const navigate = useNavigate();
  const setSearchParams = (params: SetParams, options?: Partial<NavigateOptions>) => {
    const searchString = untrack(
      () => location.pathname + mergeSearchString(location.search, params) + location.hash
    );
    navigate(searchString, {
      scroll: false,
      resolve: false,
      ...options
    });
  };
  return [location.query as Partial<T>, setSearchParams];
};

export const useBeforeLeave = (listener: (e: BeforeLeaveEventArgs) => void) => {
  const s = useRouter().beforeLeave.subscribe({
    listener,
    location: useLocation(),
    navigate: useNavigate()
  });
  onCleanup(s);
};

export function createRoutes(routeDef: RouteDefinition, base: string = ""): Route[] {
  const { component, load, children, info } = routeDef;
  const isLeaf = !children || (Array.isArray(children) && !children.length);

  const shared = {
    key: routeDef,
    component,
    load,
    info
  };

  return asArray(routeDef.path).reduce<Route[]>((acc, originalPath) => {
    for (const expandedPath of expandOptionals(originalPath)) {
      const path = joinPaths(base, expandedPath);
      let pattern = isLeaf ? path : path.split("/*", 1)[0];
      pattern = pattern
        .split("/")
        .map((s: string) => {
          return s.startsWith(":") || s.startsWith("*") ? s : encodeURIComponent(s);
        })
        .join("/");
      acc.push({
        ...shared,
        originalPath,
        pattern,
        matcher: createMatcher(pattern, !isLeaf, routeDef.matchFilters)
      });
    }
    return acc;
  }, []);
}

export function createBranch(routes: Route[], index: number = 0): Branch {
  return {
    routes,
    score: scoreRoute(routes[routes.length - 1]) * 10000 - index,
    matcher(location) {
      const matches: RouteMatch[] = [];
      for (let i = routes.length - 1; i >= 0; i--) {
        const route = routes[i];
        const match = route.matcher(location);
        if (!match) {
          return null;
        }
        matches.unshift({
          ...match,
          route
        });
      }
      return matches;
    }
  };
}

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

export function createBranches(
  routeDef: RouteDefinition | RouteDefinition[],
  base: string = "",
  stack: Route[] = [],
  branches: Branch[] = []
): Branch[] {
  const routeDefs = asArray(routeDef);

  for (let i = 0, len = routeDefs.length; i < len; i++) {
    const def = routeDefs[i];
    if (def && typeof def === "object") {
      if (!def.hasOwnProperty("path")) def.path = "";
      const routes = createRoutes(def, base);
      for (const route of routes) {
        stack.push(route);
        const isEmptyArray = Array.isArray(def.children) && def.children.length === 0;
        if (def.children && !isEmptyArray) {
          createBranches(def.children, route.pattern, stack, branches);
        } else {
          const branch = createBranch([...stack], branches.length);
          branches.push(branch);
        }

        stack.pop();
      }
    }
  }

  // Stack will be empty on final return
  return stack.length ? branches : branches.sort((a, b) => b.score - a.score);
}

export function getRouteMatches(branches: Branch[], location: string): RouteMatch[] {
  for (let i = 0, len = branches.length; i < len; i++) {
    const match = branches[i].matcher(location);
    if (match) {
      return match;
    }
  }
  return [];
}

export function createLocation(path: Accessor<string>, state: Accessor<any>): Location {
  const origin = new URL(mockBase);
  const url = createMemo<URL>(
    prev => {
      const path_ = path();
      try {
        return new URL(path_, origin);
      } catch (err) {
        console.error(`Invalid path ${path_}`);
        return prev;
      }
    },
    origin,
    {
      equals: (a, b) => a.href === b.href
    }
  );

  const pathname = createMemo(() => url().pathname);
  const search = createMemo(() => url().search, true);
  const hash = createMemo(() => url().hash);
  const key = () => "";

  return {
    get pathname() {
      return pathname();
    },
    get search() {
      return search();
    },
    get hash() {
      return hash();
    },
    get state() {
      return state();
    },
    get key() {
      return key();
    },
    query: createMemoObject(on(search, () => extractSearchParams(url())) as () => Params)
  };
}

let intent: Intent | undefined;
export function getIntent() {
  return intent;
}
let inLoadFn = false;
export function getInLoadFn() {
  return inLoadFn;
}
export function setInLoadFn(value: boolean) {
  inLoadFn = value;
}

export function createRouterContext(
  integration: RouterIntegration,
  branches: () => Branch[],
  getContext?: () => any,
  options: { base?: string; singleFlight?: boolean, transformUrl?: (url: string) => string } = {}
): RouterContext {
  const {
    signal: [source, setSource],
    utils = {}
  } = integration;

  const parsePath = utils.parsePath || (p => p);
  const renderPath = utils.renderPath || (p => p);
  const beforeLeave = utils.beforeLeave || createBeforeLeave();

  const basePath = resolvePath("", options.base || "");
  if (basePath === undefined) {
    throw new Error(`${basePath} is not a valid base path`);
  } else if (basePath && !source().value) {
    setSource({ value: basePath, replace: true, scroll: false });
  }

  const [isRouting, setIsRouting] = createSignal(false);
  const start = async (callback: () => void) => {
    setIsRouting(true);
    try {
      await startTransition(callback);
    } finally {
      setIsRouting(false);
    }
  };
  const [reference, setReference] = createSignal(source().value);
  const [state, setState] = createSignal(source().state);
  const location = createLocation(reference, state);
  const referrers: LocationChange[] = [];
  const submissions = createSignal<Submission<any, any>[]>(isServer ? initFromFlash() : []);

  const matches = createMemo(() => {
    if (typeof options.transformUrl === "function") {
      return getRouteMatches(branches(), options.transformUrl(location.pathname));
    }

    return getRouteMatches(branches(), location.pathname);
  });

  const params = createMemoObject(() => {
    const m = matches();
    const params: Params = {};
    for (let i = 0; i < m.length; i++) {
      Object.assign(params, m[i].params);
    }
    return params;
  });

  const baseRoute: RouteContext = {
    pattern: basePath,
    path: () => basePath,
    outlet: () => null,
    resolvePath(to: string) {
      return resolvePath(basePath, to);
    }
  };

  createRenderEffect(() => {
    const { value, state } = source();
    // Untrack this whole block so `start` doesn't cause Solid's Listener to be preserved
    untrack(() => {
      start(() => {
        intent = "native";
        if (value !== reference()) setReference(value);
        setState(state);
        resetErrorBoundaries();
        submissions[1]([]);
      }).then(() => {
        intent = undefined;
      });
    });
  });

  return {
    base: baseRoute,
    location,
    params,
    isRouting,
    renderPath,
    parsePath,
    navigatorFactory,
    matches,
    beforeLeave,
    preloadRoute,
    singleFlight: options.singleFlight === undefined ? true : options.singleFlight,
    submissions
  };

  function navigateFromRoute(
    route: RouteContext,
    to: string | number,
    options?: Partial<NavigateOptions>
  ) {
    // Untrack in case someone navigates in an effect - don't want to track `reference` or route paths
    untrack(() => {
      if (typeof to === "number") {
        if (!to) {
          // A delta of 0 means stay at the current location, so it is ignored
        } else if (utils.go) {
          utils.go(to);
        } else {
          console.warn("Router integration does not support relative routing");
        }
        return;
      }

      const {
        replace,
        resolve,
        scroll,
        state: nextState
      } = {
        replace: false,
        resolve: true,
        scroll: true,
        ...options
      };

      const resolvedTo = resolve ? route.resolvePath(to) : resolvePath("", to);

      if (resolvedTo === undefined) {
        throw new Error(`Path '${to}' is not a routable path`);
      } else if (referrers.length >= MAX_REDIRECTS) {
        throw new Error("Too many redirects");
      }

      const current = reference();

      if (resolvedTo !== current || nextState !== state()) {
        if (isServer) {
          const e = getRequestEvent();
          e && (e.response = { status: 302, headers: new Headers({ Location: resolvedTo }) });
          setSource({ value: resolvedTo, replace, scroll, state: nextState });
        } else if (beforeLeave.confirm(resolvedTo, options)) {
          const len = referrers.push({ value: current, replace, scroll, state: state() });
          start(() => {
            intent = "navigate";
            setReference(resolvedTo);
            setState(nextState);
            resetErrorBoundaries();
            submissions[1]([]);
          }).then(() => {
            if (referrers.length === len) {
              intent = undefined;
              navigateEnd({
                value: resolvedTo,
                state: nextState
              });
            }
          });
        }
      }
    });
  }

  function navigatorFactory(route?: RouteContext): Navigator {
    // Workaround for vite issue (https://github.com/vitejs/vite/issues/3803)
    route = route || useContext(RouteContextObj) || baseRoute;
    return (to: string | number, options?: Partial<NavigateOptions>) =>
      navigateFromRoute(route!, to, options);
  }

  function navigateEnd(next: LocationChange) {
    const first = referrers[0];
    if (first) {
      if (next.value !== first.value || next.state !== first.state) {
        setSource({
          ...next,
          replace: first.replace,
          scroll: first.scroll
        });
      }
      referrers.length = 0;
    }
  }

  function preloadRoute(url: URL, preloadData: boolean) {
    const matches = getRouteMatches(branches(), url.pathname);
    const prevIntent = intent;
    intent = "preload";
    for (let match in matches) {
      const { route, params } = matches[match];
      route.component &&
        (route.component as MaybePreloadableComponent).preload &&
        (route.component as MaybePreloadableComponent).preload!();
      const { load } = route;
      inLoadFn = true;
      preloadData &&
        load &&
        runWithOwner(getContext!(), () =>
          load({
            params,
            location: {
              pathname: url.pathname,
              search: url.search,
              hash: url.hash,
              query: extractSearchParams(url),
              state: null,
              key: ""
            },
            intent: "preload"
          })
        );
      inLoadFn = false;
    }
    intent = prevIntent;
  }

  function initFromFlash() {
    const e = getRequestEvent();
    return (e && e.router && e.router.submission
      ? [e.router.submission]
      : []) as Array<Submission<any, any>>;
  }
}

export function createRouteContext(
  router: RouterContext,
  parent: RouteContext,
  outlet: () => JSX.Element,
  match: () => RouteMatch,
): RouteContext {
  const { base, location, params } = router;
  const { pattern, component, load } = match().route;
  const path = createMemo(() => match().path);

  component &&
    (component as MaybePreloadableComponent).preload &&
    (component as MaybePreloadableComponent).preload!();
  inLoadFn = true;
  const data = load ? load({ params, location, intent: intent || "initial" }) : undefined;
  inLoadFn = false;

  const route: RouteContext = {
    parent,
    pattern,
    path,
    outlet: () =>
      component
        ? createComponent(component, {
            params,
            location,
            data,
            get children() {
              return outlet();
            }
          })
        : outlet(),
    resolvePath(to: string) {
      return resolvePath(base.path(), to, path());
    }
  };

  return route;
}
