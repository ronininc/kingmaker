"""Kingmaker CLI Hub: no analytics.

Upstream CLI-Anything's hub sent every run, install and launch to Umami / PostHog by default (opt-out only), with a
persistent machine id. Kingmaker's copy sends nothing anywhere: these keep the names the rest of the hub imports and
do nothing.
"""


def detect_invocation_context():
    return {}


def _noop(*_args, **_kwargs):
    return None


track_event = track_first_run = track_visit = track_install = track_uninstall = track_launch = _noop
track_matrix_install = track_matrix_preflight = track_matrix_discover = track_matrix_info = track_hub_installed = _noop
